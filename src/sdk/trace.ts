import { AsyncLocalStorage } from 'node:async_hooks';
import { onCall, type CallTrace } from '../grpc/GrpcInvoker';

export interface TraceEvent extends CallTrace {
  /** 1-based order this call finished in, within the current invocation. */
  seq: number;
  /** Epoch ms when the call finished. */
  ts: number;
}

export interface InvocationTrace {
  mission: string;
  startedAt: number;
  /** Set once the invocation finishes - undefined while still running. */
  finishedAt?: number;
  /** Every `ctx.sdk.*`/global-import call made anywhere during this invocation, in completion order -
   *  including calls made inside nested async work the handler kicked off and awaited. */
  events: TraceEvent[];
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

/** Runs `fn` with a fresh trace bound to the current async context, and returns both the result
 *  (or rethrows) and the completed trace via the `onFinish` callback - called in both the success
 *  and failure case, so a failed invocation's partial trace is never lost. */
export async function withTrace<T>(
  mission: string,
  fn: () => Promise<T>,
  onFinish?: (trace: InvocationTrace) => void,
): Promise<T> {
  const trace: InvocationTrace = { mission, startedAt: Date.now(), events: [] };
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

/**
 * Developer-friendly console rendering of a finished invocation trace - a flat timeline (call
 * order, namespace, duration, attempts, outcome), not a raw JSON dump. Deliberately plain text, no
 * ANSI color codes - this runs inside `PluginServer` itself, including in a production Docker
 * container, where colored output would just pollute structured logs. `bin/cli.mjs` (a real ESM
 * file, not part of the compiled CJS `dist/`) re-colors this with `chalk` for local dev instead -
 * see its `formatTraceColor` helper.
 */
export function formatTraceForConsole(trace: InvocationTrace): string {
  const totalMs = (trace.finishedAt ?? Date.now()) - trace.startedAt;
  const lines: string[] = [];
  lines.push(`\nTrace: "${trace.mission}" — ${trace.events.length} call(s), ${totalMs}ms total`);

  if (trace.events.length === 0) {
    lines.push('  (no sdk.* calls were made)');
  }

  for (const event of trace.events) {
    const retrySuffix = event.attempts > 1 ? ` (${event.attempts} attempts)` : '';
    const errorSuffix = event.error ? ` — ${event.error}` : '';
    lines.push(
      `  ${statusIcon(event.success)} ${String(event.seq).padStart(2, '0')}  ${event.namespace}` +
        `  ${event.durationMs}ms${retrySuffix}${errorSuffix}`,
    );
  }

  lines.push(
    trace.success
      ? `  Result: success (${totalMs}ms)`
      : `  Result: failed (${totalMs}ms) — ${trace.error}`,
  );
  return lines.join('\n');
}
