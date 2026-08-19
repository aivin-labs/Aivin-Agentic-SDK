import { AsyncLocalStorage } from 'node:async_hooks';
import * as util from 'node:util';
import { onCall, resolveSdkSecret, type CallTrace } from '../grpc/GrpcInvoker';

export interface TraceEvent extends CallTrace {
  /** 1-based order this call finished in, within the current invocation - shares a counter with
   *  `CapturedLog.seq` so calls and console output can be merged into one true timeline. */
  seq: number;
  /** Epoch ms when the call finished. */
  ts: number;
}

export type CapturedLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface CapturedLog {
  level: CapturedLogLevel;
  /** Already formatted the same way `console.log` would print it (`util.format` over the raw
   *  args) - objects/errors/%s-style substitution all render exactly as they would in a terminal. */
  message: string;
  /** Epoch ms when the line was logged. */
  ts: number;
  /** Shares `TraceEvent.seq`'s counter - lets a viewer interleave calls and console output in the
   *  order they actually happened. */
  seq: number;
}

export interface InvocationTrace {
  mission: string;
  startedAt: number;
  /** Set once the invocation finishes - undefined while still running. */
  finishedAt?: number;
  /** Every `ctx.sdk.*`/global-import call made anywhere during this invocation, in completion order -
   *  including calls made inside nested async work the handler kicked off and awaited. */
  events: TraceEvent[];
  /** Every `console.log/info/warn/error/debug` call made anywhere during this invocation - see
   *  `installConsoleCapture` below for how plain `console.*` calls in plugin code end up here. */
  logs: CapturedLog[];
  success?: boolean;
  error?: string;
}

/**
 * Scoped per plugin invocation (see `PluginServer.executeHandler`), isolated across concurrent
 * invocations the same way `currentInvocation.ts` isolates the active `SDKClient` - each gets its
 * own async context, so events from one invocation never leak into another's trace even when both
 * are in flight at once in the same process.
 */
const traceStorage = new AsyncLocalStorage<InvocationTrace>();
let seqCounter = 0;

// One global subscription for the whole process - routes each finished call into whichever
// invocation's trace is active in the async context it happened in (or drops it if none is, e.g.
// a `sdk.*` call made outside of `main()`, which `getCurrentSDK()` would already have rejected).
onCall((call: CallTrace) => {
  const active = traceStorage.getStore();
  if (!active) return;
  active.events.push({ ...call, seq: ++seqCounter, ts: Date.now() });
});

/** Hard cap on captured console lines per invocation - a runaway `console.log` in a loop bug
 *  must never turn into an unbounded array (and, downstream, an unbounded `realtime.publish`
 *  payload if `AIVIN_TRACE_PUBLISH=true`). Once hit, one final marker line is appended and further
 *  output is silently dropped from the trace - the real `console.*` output (local terminal /
 *  `aivin plugin logs`) is completely unaffected either way. */
const MAX_CAPTURED_LOGS = 200;
/** Hard cap on a single formatted line - guards against one `console.log(hugeBlob)` dominating the
 *  trace payload. */
const MAX_LOG_LINE_CHARS = 4000;

/**
 * Generic, credential-*shaped* patterns worth scrubbing from captured console text even though
 * they're not the SDK's own secret - a plugin author's own `console.log` debugging a 3rd-party API
 * call routinely includes THEIR OpenAI/AWS/DB credentials, not just ours, and once
 * `AIVIN_TRACE_PUBLISH=true` those lines travel to `realtime.publish` (whole-workspace audience)
 * same as everything else in the trace. Deliberately narrow, low-false-positive shapes - this is
 * pattern matching on a handful of common leak shapes, not a general secret scanner.
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bBearer\s+[A-Za-z0-9\-_.~+/]{16,}=*/gi, replacement: '[REDACTED]' }, // Authorization: Bearer <token>
  { pattern: /\bBasic\s+[A-Za-z0-9+/]{16,}=*/gi, replacement: '[REDACTED]' }, // Authorization: Basic <base64>
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '[REDACTED]' }, // JWT
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED]' }, // AWS access key id
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED]' }, // OpenAI-style secret key
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED]',
  }, // PEM private key
  { pattern: /(:\/\/)[^\s:@/]+:[^\s:@/]+@/g, replacement: '$1[REDACTED]@' }, // scheme://user:pass@host - keeps the scheme visible, only masks the credential
];

/**
 * Masks the resolved SDK secret (see `resolveSdkSecret` in `GrpcInvoker.ts`), plus anything
 * matching `SENSITIVE_PATTERNS` above, out of captured console text before it's ever stored on a
 * trace. The trace is meant to travel further than a plain `console.log` would
 * (`AIVIN_TRACE_PUBLISH=true` sends it to another plugin's caller via `realtime.publish`) - a
 * stray `console.log(process.env)` (or a debug line with someone else's API key in it) must not
 * turn into a wider leak just because it now has a second audience.
 *
 * LIMITATION: this is literal/pattern substring matching, not a full DLP scanner. It catches the
 * common case (`console.log(process.env)`, an error message that happens to include an auth
 * header, a stray API key in a debug line) but not a deliberately obfuscated/fragmented/encoded
 * copy of a credential - this is a safety net against accidental leaks, not a guarantee against a
 * plugin trying to exfiltrate its own secret on purpose (that risk is inherent to running
 * untrusted code in the same process, not something console redaction can close).
 */
function redactSensitive(message: string): string {
  const secret = resolveSdkSecret();
  let result = secret ? message.split(secret).join('[REDACTED]') : message;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function captureLog(level: CapturedLogLevel, args: unknown[]): void {
  const active = traceStorage.getStore();
  // Also skip once the invocation has already finished - `PluginServer.reportTrace` prints
  // `formatTraceForConsole(trace)` via `console.log` from inside the same async context (the trace
  // is only handed to `onFinish` after `finishedAt` is set), which would otherwise capture the
  // trace's own printed summary back into itself.
  if (!active || active.finishedAt !== undefined) return;

  if (active.logs.length > MAX_CAPTURED_LOGS) return;
  if (active.logs.length === MAX_CAPTURED_LOGS) {
    active.logs.push({
      level: 'warn',
      message: `… console output truncated after ${MAX_CAPTURED_LOGS} line(s)`,
      ts: Date.now(),
      seq: ++seqCounter,
    });
    return;
  }

  let message = redactSensitive(util.format(...args));
  if (message.length > MAX_LOG_LINE_CHARS) {
    message = `${message.slice(0, MAX_LOG_LINE_CHARS)}… (+${message.length - MAX_LOG_LINE_CHARS} chars truncated)`;
  }
  active.logs.push({ level, message, ts: Date.now(), seq: ++seqCounter });
}

const CAPTURED_CONSOLE_METHODS: CapturedLogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];
let consoleCaptureInstalled = false;

/**
 * Wraps `console.log/info/warn/error/debug` globally, once per process, so plain `console.*`
 * calls anywhere in a plugin's own code (not just `sdk.log()`) end up on the active invocation's
 * trace too - see `CapturedLog`. Always calls through to the original method first: this is
 * strictly additive, nothing about what shows up in the local terminal or a deployed container's
 * stdout (and therefore `aivin plugin logs`) changes. Set `AIVIN_TRACE_LOGS=false` to disable just
 * this capture (independent of `AIVIN_TRACE`, which gates the call-trace summary/print instead) -
 * e.g. for a plugin that logs large blobs it doesn't want duplicated into the trace payload.
 */
function installConsoleCapture(): void {
  if (consoleCaptureInstalled) return;
  consoleCaptureInstalled = true;

  for (const level of CAPTURED_CONSOLE_METHODS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      if (process.env.AIVIN_TRACE_LOGS !== 'false') {
        captureLog(level, args);
      }
    };
  }
}

installConsoleCapture();

/** Runs `fn` with a fresh trace bound to the current async context, and returns both the result
 *  (or rethrows) and the completed trace via the `onFinish` callback - called in both the success
 *  and failure case, so a failed invocation's partial trace is never lost. */
export async function withTrace<T>(
  mission: string,
  fn: () => Promise<T>,
  onFinish?: (trace: InvocationTrace) => void,
): Promise<T> {
  const trace: InvocationTrace = { mission, startedAt: Date.now(), events: [], logs: [] };
  return traceStorage.run(trace, async () => {
    try {
      const result = await fn();
      trace.success = true;
      trace.finishedAt = Date.now();
      onFinish?.(trace);
      return result;
    } catch (err: any) {
      trace.success = false;
      trace.error = err?.message ?? String(err);
      trace.finishedAt = Date.now();
      onFinish?.(trace);
      throw err;
    }
  });
}

/** Read the trace of the invocation currently running - usable from inside `main()` itself (e.g.
 *  to enrich a `PluginResponse` with which calls it made). Returns undefined outside an invocation. */
export function getCurrentTrace(): InvocationTrace | undefined {
  return traceStorage.getStore();
}

const statusIcon = (success?: boolean): string => (success === undefined ? '…' : success ? '✓' : '✗');

type TimelineEntry =
  | { kind: 'call'; seq: number; event: TraceEvent }
  | { kind: 'log'; seq: number; log: CapturedLog };

/**
 * Developer-friendly console rendering of a finished invocation trace - a flat, chronological
 * timeline merging `ctx.sdk.*` calls AND raw `console.*` output (by their shared `seq`), not a raw
 * JSON dump. Deliberately plain text, no ANSI color codes - this runs inside `PluginServer` itself,
 * including in a production Docker container, where colored output would just pollute structured
 * logs. `bin/cli.mjs` (a real ESM file, not part of the compiled CJS `dist/`) re-colors this with
 * `chalk` for local dev instead - see its `formatTraceColor` helper.
 */
export function formatTraceForConsole(trace: InvocationTrace): string {
  const totalMs = (trace.finishedAt ?? Date.now()) - trace.startedAt;
  const lines: string[] = [];
  lines.push(
    `\nTrace: "${trace.mission}" — ${trace.events.length} call(s), ${trace.logs.length} log line(s), ${totalMs}ms total`,
  );

  const timeline: TimelineEntry[] = [
    ...trace.events.map((event): TimelineEntry => ({ kind: 'call', seq: event.seq, event })),
    ...trace.logs.map((log): TimelineEntry => ({ kind: 'log', seq: log.seq, log })),
  ].sort((a, b) => a.seq - b.seq);

  if (timeline.length === 0) {
    lines.push('  (no sdk.* calls or console output)');
  }

  for (const entry of timeline) {
    const seqLabel = String(entry.seq).padStart(3, '0');
    if (entry.kind === 'call') {
      const event = entry.event;
      const retrySuffix = event.attempts > 1 ? ` (${event.attempts} attempts)` : '';
      const errorSuffix = event.error ? ` — ${event.error}` : '';
      lines.push(
        `  ${statusIcon(event.success)} ${seqLabel}  call  ${event.namespace}` +
          `  ${event.durationMs}ms${retrySuffix}${errorSuffix}`,
      );
    } else {
      lines.push(`    ${seqLabel}  ${entry.log.level.padEnd(5)} ${entry.log.message}`);
    }
  }

  lines.push(
    trace.success
      ? `  Result: success (${totalMs}ms)`
      : `  Result: failed (${totalMs}ms) — ${trace.error}`,
  );
  return lines.join('\n');
}
