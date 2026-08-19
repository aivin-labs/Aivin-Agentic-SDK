import * as fs from 'fs';
import * as path from 'path';
import * as grpc from '@grpc/grpc-js';
import { loadSdkTransportService } from './loadProto';
import type { ParsedLine } from '../types/SDKTypes';

export interface InvokeRequest {
  namespace: string;
  params?: unknown;
  context?: unknown;
  timeoutMs?: number;
  /** Max retry attempts for transport-level failures (default: 2, i.e. up to 3 tries total).
   *  Set to 0 to disable retries for this call. See `isRetryableTransportError` for what qualifies -
   *  only failures where the request never reached the server are retried; anything that might have
   *  executed server-side is never auto-retried (no idempotency-key mechanism exists to make that safe). */
  maxRetries?: number;
  /** Cancels the underlying gRPC call when aborted (`call.cancel()`), for both `invokeHost` and
   *  `invokeHostStream`. The host observes this as its OWN call's `'cancelled'` event and aborts
   *  whatever it's doing on that basis - the request actually stops running/being billed
   *  server-side, not just "the client stops listening" while generation continues regardless.
   *  Already-aborted at call time -> fails immediately, no attempt made (and never retried - a
   *  CANCELLED status is not in `isRetryableTransportError`'s retryable set). */
  signal?: AbortSignal;
}

type GrpcInvokeClient = {
  Invoke: (req: any, meta: grpc.Metadata, opts: any, cb: (err: any, res: any) => void) => { cancel: () => void };
  InvokeStream: (req: any, meta: grpc.Metadata, opts: any) => NodeJS.ReadableStream;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = Number(process.env.SDK_GRPC_MAX_RETRIES ?? 2);
const RETRY_BASE_DELAY_MS = 200;
const RETRY_MAX_DELAY_MS = 4_000;

/**
 * Only UNAVAILABLE is retried - it means the channel couldn't reach the server at all (connection
 * refused, DNS failure, transient network blip), so the request itself was never processed and a
 * retry can't cause double-execution. DEADLINE_EXCEEDED/INTERNAL/etc are deliberately excluded:
 * the request may have already reached and been processed by the server, and this transport has no
 * idempotency-key mechanism to make re-sending those safe.
 */
function isRetryableTransportError(error: any): boolean {
  return error?.code === grpc.status.UNAVAILABLE;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter, capped at RETRY_MAX_DELAY_MS. */
function backoffDelay(attempt: number): number {
  const exp = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  return Math.random() * exp;
}

/**
 * Generic retry-with-backoff wrapper, decoupled from gRPC specifics so it's directly unit
 * testable without mocking the proto/transport layer. `isRetryable` decides whether a given
 * error qualifies (see `isRetryableTransportError` for the real transport policy used below).
 */
export async function withRetry<T>(
  attemptOnce: () => Promise<T>,
  opts: { maxRetries: number; isRetryable: (err: any) => boolean; onRetry?: (attempt: number, err: any) => void },
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await attemptOnce();
    } catch (err: any) {
      lastError = err;
      const isLastAttempt = attempt === opts.maxRetries;
      if (isLastAttempt || !opts.isRetryable(err)) throw err;
      opts.onRetry?.(attempt, err);
      await sleep(backoffDelay(attempt));
    }
  }
  throw lastError;
}

/**
 * Falls back to the production endpoint when SDK_ENDPOINT isn't set, so `ctx.sdk.*` still
 * works out of the box during local `aivin start` testing (against real production data - set
 * SDK_ENDPOINT yourself to point at a local/dev/staging backend instead). Inside a deployed
 * container this env var is always injected by the host, so this fallback never applies there.
 *
 * `sdk.aivin.cloud:443` is production's gRPC entry behind the load balancer - a separate host from
 * `api.aivin.cloud` (the REST API `AIVIN_BASE_URL` points at) and not the same path staging uses.
 */
const DEFAULT_ENDPOINT = 'sdk.aivin.cloud:443';

let cachedClient: GrpcInvokeClient | undefined;
let cachedEndpoint: string | undefined;
let warnedDefaultEndpoint = false;

/**
 * Explicit override for `endpoint`/`secret`, set via `configureTransport()` instead of
 * `process.env.SDK_ENDPOINT`/`SDK_SECRET` - for callers that mint their own per-invocation identity
 * at runtime (e.g. a test harness driving `mintCap()`) and want to hand it straight to the SDK
 * without going through a process-wide global. Takes priority over env/file resolution in
 * `resolveEndpoint()`/`resolveSdkSecret()` below, but doesn't replace them: a real deployed
 * container never calls this, and keeps working exactly as before (`SDK_SECRET_FILE`/`SDK_SECRET`/
 * `SDK_ENDPOINT`, injected by the host - see those functions' own comments).
 */
let explicitTransportConfig: { endpoint?: string; secret?: string } = {};

/**
 * Hand the SDK an endpoint/secret directly instead of setting `process.env.SDK_ENDPOINT`/
 * `SDK_SECRET` yourself. Clears the cached gRPC client/endpoint/secret so the new values take
 * effect on the very next call, even if something already invoked the SDK earlier in this process.
 */
export function configureTransport(config: { endpoint?: string; secret?: string }): void {
  explicitTransportConfig = { ...explicitTransportConfig, ...config };
  cachedClient = undefined;
  cachedEndpoint = undefined;
  cachedSecret = undefined;
}

export interface CallTrace {
  namespace: string;
  durationMs: number;
  attempts: number;
  success: boolean;
  error?: string;
}

const callInterceptors = new Set<(trace: CallTrace) => void>();

/**
 * Lightweight observability hook - no bundled tracing library (keeps the SDK dependency-free),
 * just a plain callback fired after every `invokeHost` call finishes. Wire it up to
 * OpenTelemetry/Datadog/whatever the host project already uses. Returns an unsubscribe function.
 */
export function onCall(listener: (trace: CallTrace) => void): () => void {
  callInterceptors.add(listener);
  return () => callInterceptors.delete(listener);
}

/** Test-only escape hatch to simulate a finished call firing through `onCall`'s listeners (and
 *  anything built on it, like `trace.ts`'s per-invocation collector) without a real gRPC round
 *  trip. Not useful in real plugin code - `invokeHost` calls this internally on every real call. */
export function emitTraceForTest(trace: CallTrace): void {
  emitTrace(trace);
}

/**
 * Fires a finished call through every `onCall()` listener - what `invokeHost`/`invokeHostStream`
 * call internally on every real call, and what `worker/PluginWorkerRuntime`'s relayed `sdk.call`/
 * `sdk.stream.*` calls also call directly (they never reach `invokeHost` itself, since the actual
 * network call happens host-side - see `PluginWorkerHost`), so a sandboxed invocation's trace
 * still gets a real `CallTrace` entry per call, same as an unsandboxed one.
 */
export function emitTrace(trace: CallTrace): void {
  for (const listener of callInterceptors) {
    try {
      listener(trace);
    } catch {
      // A misbehaving interceptor must never break the actual RPC call.
    }
  }
  // `SDK_DEBUG=true` - human-readable one-liner per call, live as it happens (not batched/post-hoc
  // like `formatTraceForConsole`, which only prints once the whole invocation finishes). Set by
  // `aivin start --debug`.
  if (process.env.SDK_DEBUG === 'true') {
    const outcome = trace.success ? 'ok' : `FAILED: ${trace.error}`;
    console.debug(
      `[@aivin-labs/sdk] ${trace.namespace} (${trace.durationMs}ms, ${trace.attempts} attempt(s)) - ${outcome}`,
    );
  }
  // `SDK_DEBUG=json` - same live-per-call signal, structured as one JSON object per line instead of
  // a formatted string. Meant for a coding agent (or any script) reading this process's stdout to
  // parse programmatically - a free-text line requires the reader to know this SDK's exact log
  // format; a JSON-lines stream doesn't. Written to stdout (not stderr/console.debug) specifically
  // so a `| grep '"type":"sdk_call"'`-style pipeline sees it without stderr interleaving.
  if (process.env.SDK_DEBUG === 'json') {
    process.stdout.write(
      JSON.stringify({
        type: 'sdk_call',
        namespace: trace.namespace,
        duration_ms: trace.durationMs,
        attempts: trace.attempts,
        success: trace.success,
        error: trace.error,
        ts: Date.now(),
      }) + '\n',
    );
  }
}

function isLocalEndpoint(endpoint: string): boolean {
  const host = endpoint.split(':')[0].toLowerCase();
  return ['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal'].includes(host);
}

interface MtlsIdentity {
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
}

let explicitMtls: MtlsIdentity = {};

/**
 * PROTOTYPE - client-cert (mTLS) identity, read once from a local directory instead of going
 * through the container-secret Bearer flow (`configureTransport({ secret })` / `SDK_SECRET_FILE`).
 * Purely additive for now: the host side of this is not fully built out yet, so a call made with
 * this configured still needs `secret`/`cap` to actually authenticate, exactly as before. This
 * exists to shape the client-side API ahead of that server-side work, not to replace anything in a
 * live call yet. Don't rely on this for any actual security guarantee.
 *
 * Expects `ca.pem`, `client.crt`, `client.key` in `certDir` - deliberately the same one-directory-
 * per-machine shape as `~/.aivin/credentials`, so `aivin login` could someday write these the same
 * way instead of a separate config surface. Resets the cached gRPC client so a new identity takes
 * effect on the very next call.
 */
export function configureMtls(config: { certDir?: string; ca?: string | Buffer; cert?: string | Buffer; key?: string | Buffer }): void {
  const read = (filePath: string): Buffer | undefined => (fs.existsSync(filePath) ? fs.readFileSync(filePath) : undefined);
  const toBuffer = (value: string | Buffer | undefined): Buffer | undefined =>
    value === undefined ? undefined : Buffer.isBuffer(value) ? value : Buffer.from(value);

  explicitMtls = {
    ca: toBuffer(config.ca) ?? (config.certDir ? read(path.join(config.certDir, 'ca.pem')) : undefined),
    cert: toBuffer(config.cert) ?? (config.certDir ? read(path.join(config.certDir, 'client.crt')) : undefined),
    key: toBuffer(config.key) ?? (config.certDir ? read(path.join(config.certDir, 'client.key')) : undefined),
  };
  cachedClient = undefined;
  cachedEndpoint = undefined;
}

/**
 * TLS by default for anything that isn't a local/loopback/container-internal address - this
 * endpoint may now point at a real host over the public internet. Override with
 * SDK_GRPC_TLS=true|false if you need to force one way or the other (e.g. a local endpoint that
 * still requires TLS, or a remote one that's plaintext on a private network).
 *
 * Presents `explicitMtls`'s client cert on the handshake when configured (see `configureMtls`) -
 * harmless no-op against a server that isn't asking for one yet, and `rootCerts` left `undefined`
 * (not `explicitMtls.ca`) unless a custom CA was actually given, so the system's default trust
 * store still validates the *server's* cert exactly as before (mTLS adds a client identity to the
 * handshake, it doesn't change how this side trusts the server).
 */
function buildCredentials(endpoint: string): grpc.ChannelCredentials {
  const override = process.env.SDK_GRPC_TLS;
  const useTls = override ? override.toLowerCase() === 'true' : !isLocalEndpoint(endpoint);
  if (!useTls) return grpc.credentials.createInsecure();
  if (explicitMtls.cert && explicitMtls.key) {
    return grpc.credentials.createSsl(explicitMtls.ca, explicitMtls.key, explicitMtls.cert);
  }
  return grpc.credentials.createSsl();
}

function getClient(endpoint: string): GrpcInvokeClient {
  if (cachedClient && cachedEndpoint === endpoint) return cachedClient;

  const ServiceCtor = loadSdkTransportService();
  cachedClient = new ServiceCtor(
    endpoint,
    buildCredentials(endpoint),
  ) as unknown as GrpcInvokeClient;
  cachedEndpoint = endpoint;
  return cachedClient;
}

let cachedSecret: string | null | undefined; // undefined = not yet resolved this process

/**
 * Reads the per-container gRPC secret once and caches it in this module-private variable - NEVER
 * re-exposed via `process.env`, deliberately. If it stayed in `process.env` (the old design: BE
 * wrote it via `env_file:` in docker-compose), any code running in this same container - including
 * the plugin's own business logic, which is untrusted community code sharing this one OS process -
 * could leak it with something as ordinary as a debug `console.log(process.env)`. That output goes
 * straight to the container's stdout, which the host streams live to anyone watching
 * `aivin plugin logs`. Reading it from a file instead closes that off entirely - only code that
 * explicitly reads this exact file path can ever see the value.
 *
 * `SDK_SECRET_FILE` (set by the host alongside the bind-mounted `.secrets.env` file) points at
 * where to read it from; `SDK_SECRET` (plain env var) is kept as a fallback for `aivin start`
 * local testing, where there's no real container/host relationship and no file to mount.
 */
export function resolveSdkSecret(): string | undefined {
  if (explicitTransportConfig.secret) return explicitTransportConfig.secret;
  if (cachedSecret !== undefined) return cachedSecret ?? undefined;
  const filePath = process.env.SDK_SECRET_FILE;
  if (!filePath) {
    cachedSecret = process.env.SDK_SECRET || null;
    return cachedSecret ?? undefined;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    // Same dotenv-style shape the host writes (`SDK_SECRET=<value>`) -
    // tolerate a bare value too in case something mounts just the raw secret directly.
    const match = raw.match(/^SDK_SECRET=(.*)$/m);
    cachedSecret = (match ? match[1] : raw).trim() || null;
  } catch (err: any) {
    console.warn(`[@aivin-labs/sdk] Could not read SDK_SECRET_FILE (${filePath}): ${err.message}`);
    cachedSecret = null;
  }
  return cachedSecret ?? undefined;
}

function resolveEndpoint(): string {
  if (explicitTransportConfig.endpoint) return explicitTransportConfig.endpoint;
  const endpoint = process.env.SDK_ENDPOINT;
  if (endpoint) return endpoint;
  if (!warnedDefaultEndpoint) {
    warnedDefaultEndpoint = true;
    console.warn(
      `[@aivin-labs/sdk] SDK_ENDPOINT not set - defaulting to production (${DEFAULT_ENDPOINT}). ` +
        'Set SDK_ENDPOINT to point at a local/dev backend instead.',
    );
  }
  return DEFAULT_ENDPOINT;
}

/**
 * Outbound call: plugin -> Aivin host. Mirrors the backend's own
 * `GrpcTransportAdapter.invokeOnce` so the wire format matches exactly.
 */
export async function invokeHost<T = any>(request: InvokeRequest): Promise<T> {
  const endpoint = resolveEndpoint();
  const client = getClient(endpoint);
  const secret = resolveSdkSecret();
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = request.maxRetries ?? DEFAULT_MAX_RETRIES;

  const attemptOnce = (): Promise<T> => {
    if (request.signal?.aborted) {
      return Promise.reject(new Error(`gRPC invoke '${request.namespace}' aborted before it started`));
    }

    const metadata = new grpc.Metadata();
    if (secret) metadata.set('authorization', `Bearer ${secret}`);
    const deadline = new Date(Date.now() + timeoutMs);

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => call.cancel();
      const detach = () => request.signal?.removeEventListener('abort', onAbort);

      const call = client.Invoke(
        {
          namespace: request.namespace,
          params_json: JSON.stringify(request.params ?? {}),
          context_json: JSON.stringify(request.context ?? {}),
        },
        metadata,
        { deadline },
        (error: any, response: any) => {
          detach();
          if (error) {
            const wrapped = new Error(
              `gRPC invoke '${request.namespace}' failed: ${error.message || error}`,
            );
            (wrapped as any).code = error.code;
            reject(wrapped);
            return;
          }
          if (!response?.success) {
            reject(
              new Error(response?.error || `gRPC invoke returned failure for ${request.namespace}`),
            );
            return;
          }
          if (!response?.data_json) {
            resolve(undefined as T);
            return;
          }
          try {
            resolve(JSON.parse(response.data_json) as T);
          } catch {
            resolve(response.data_json as T);
          }
        },
      );
      request.signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  const startedAt = Date.now();
  let attemptsMade = 0;
  try {
    const result = await withRetry(
      () => {
        attemptsMade++;
        return attemptOnce();
      },
      {
        maxRetries,
        isRetryable: isRetryableTransportError,
        onRetry: (attempt) =>
          console.warn(
            `[@aivin-labs/sdk] '${request.namespace}' unreachable (attempt ${attempt + 1}/${maxRetries + 1}), retrying...`,
          ),
      },
    );
    emitTrace({
      namespace: request.namespace,
      durationMs: Date.now() - startedAt,
      attempts: attemptsMade,
      success: true,
    });
    return result;
  } catch (err: any) {
    emitTrace({
      namespace: request.namespace,
      durationMs: Date.now() - startedAt,
      attempts: attemptsMade,
      success: false,
      error: err?.message,
    });
    throw err;
  }
}

export interface StreamHandle<T = any> {
  /** Incremental text deltas, in arrival order - drains from the network eagerly as soon as this
   *  handle is created, independent of whether/how fast the consumer iterates. Safe to ignore
   *  entirely and just await `final` if you don't need per-chunk access. */
  chunks: AsyncGenerator<string, void, void>;
  /** Resolves to the same aggregated value `invokeHost()` would have returned for the equivalent
   *  unary call, once the stream's final chunk arrives. Rejects if the stream errors, whether or
   *  not `chunks` was ever iterated. */
  final: Promise<T>;
  /** Structured `parsed_line` events (`SdkStreamChunk.event_type`/`event_json`) - populated only by
   *  routes that emit them (currently just `ai.promptStream` when the request set `opts.lineSchema`;
   *  see `DriverHelper.wrapListenerForLineWatch` on the host). Simply never yields for every other
   *  namespace/request, same as an empty stream - safe to ignore like `chunks`. A line that didn't
   *  match `opts.lineSchema` (`parsed === null` server-side) is silently skipped here, not yielded
   *  as null - use `rawLines` if you need an unmatched line's raw text. Also eagerly drains alongside
   *  `chunks`/`final`, same caveat as `chunks` above. */
  lines: AsyncGenerator<ParsedLine, void, void>;
  /** Raw per-line text (`'\n'`-delimited, same buffering `lines` uses server-side), unconditionally
   *  populated by routes that support it (currently `ai.promptStream` - NOT gated behind
   *  `opts.lineSchema`, unlike `lines` above). Same drain/ignore caveats as `chunks`. */
  rawLines: AsyncGenerator<string, void, void>;
  /** Reasoning-model "thinking" text deltas, separate from `chunks` (which only ever carries the
   *  final-answer text). Unconditionally populated by routes that support it (currently
   *  `ai.promptStream`); simply never yields for a model/request with no reasoning output. Same
   *  drain/ignore caveats as `chunks`. */
  reasoning: AsyncGenerator<string, void, void>;
}

/** One `{push, finish, iterator}` triple per event type `invokeHostStream` demultiplexes off the
 *  wire - `chunks`/`lines`/`rawLines`/`reasoning` on `StreamHandle` are all instances of this same
 *  buffered-queue-plus-async-generator shape, so this is the one place that logic is written.
 *  `getError`/`isEnded` read the SHARED (not per-queue) `streamError`/`ended` state from the
 *  enclosing `invokeHostStream` call - every queue ends together, when the underlying gRPC stream
 *  itself ends, not independently. */
export function createStreamQueue<V>(getError: () => any, isEnded: () => boolean): {
  push: (value: V) => void;
  finish: () => void;
  iterator: AsyncGenerator<V, void, void>;
} {
  const buffered: V[] = [];
  const waiters: Array<(result: IteratorResult<V, void>) => void> = [];

  const push = (value: V) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ value, done: false });
    else buffered.push(value);
  };
  const finish = () => {
    while (waiters.length) waiters.shift()!({ value: undefined, done: true });
  };

  async function* generate(): AsyncGenerator<V, void, void> {
    for (;;) {
      if (buffered.length) {
        yield buffered.shift()!;
        continue;
      }
      if (isEnded()) {
        const err = getError();
        if (err) throw err;
        return;
      }
      const result = await new Promise<IteratorResult<V, void>>((resolve) => waiters.push(resolve));
      if (result.done) {
        const err = getError();
        if (err) throw err;
        return;
      }
      yield result.value as V;
    }
  }

  return { push, finish, iterator: generate() };
}

/**
 * Server-streaming counterpart of `invokeHost` - only namespaces the host has registered as
 * streaming-capable (currently `ai.promptStream`) actually stream; the backend transparently falls
 * back to the unary handler (as one chunk) for anything else. Deliberately has NO automatic retry
 * (unlike `invokeHost`): a stream can be partway through
 * delivering chunks to the caller when a transport error happens, and there's no way to resume or
 * safely re-run a partially-observed stream without risking duplicated/interleaved output.
 */
export function invokeHostStream<T = any>(request: InvokeRequest): StreamHandle<T> {
  const endpoint = resolveEndpoint();
  const client = getClient(endpoint);
  const secret = resolveSdkSecret();
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  const metadata = new grpc.Metadata();
  if (secret) metadata.set('authorization', `Bearer ${secret}`);
  const deadline = new Date(Date.now() + timeoutMs);

  const call = client.InvokeStream(
    {
      namespace: request.namespace,
      params_json: JSON.stringify(request.params ?? {}),
      context_json: JSON.stringify(request.context ?? {}),
    },
    metadata,
    { deadline },
  ) as any;

  // Same mechanics as `invokeHost`'s `signal` handling - see `InvokeRequest.signal`'s doc comment.
  // Already-aborted-before-start still goes through the normal call+cancel path (no separate
  // "never even start" branch like `invokeHost` has) - `call.on('error', ...)` below picks up the
  // resulting CANCELLED status exactly like a mid-stream cancel would, so `chunks`/`lines`/`final`
  // all reject consistently either way.
  const onAbort = () => call.cancel();
  const detachAbort = () => request.signal?.removeEventListener('abort', onAbort);
  if (request.signal?.aborted) onAbort();
  else request.signal?.addEventListener('abort', onAbort, { once: true });

  let ended = false;
  let streamError: any;
  let finalValue: T | undefined;
  let resolveFinal!: (value: T) => void;
  let rejectFinal!: (err: any) => void;
  const final = new Promise<T>((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });
  // `chunks` and `final` are two independent ways to consume the same stream - a caller is free to
  // use only one (e.g. just `for await...of chunks`, never touching `final`). Without this, a
  // rejected `final` nobody ever awaited/`.catch()`'d becomes an unhandled promise rejection, which
  // crashes the whole process on modern Node by default. This extra handler doesn't consume the
  // rejection for real callers - `await result.text` / `.catch()` on the returned `final` still see
  // it normally; this only stops Node from treating it as *unhandled*.
  final.catch(() => {});

  const getError = () => streamError;
  const isEnded = () => ended;
  const chunkQueue = createStreamQueue<string>(getError, isEnded);
  const lineQueue = createStreamQueue<ParsedLine>(getError, isEnded);
  const rawLineQueue = createStreamQueue<string>(getError, isEnded);
  const reasoningQueue = createStreamQueue<string>(getError, isEnded);
  const finish = () => {
    if (ended) return;
    ended = true;
    chunkQueue.finish();
    lineQueue.finish();
    rawLineQueue.finish();
    reasoningQueue.finish();
  };

  // Attaching a 'data' listener puts the gRPC ClientReadableStream into flowing mode immediately -
  // this is what makes the stream self-draining regardless of whether the caller ever reads
  // `chunks` (see StreamHandle's doc comment on `final`).
  call.on('data', (msg: any) => {
    if (msg?.success === false) {
      streamError = new Error(msg.error || `gRPC stream invoke returned failure for ${request.namespace}`);
      return;
    }
    if (msg?.delta) chunkQueue.push(msg.delta);
    if (msg?.event_type && msg?.event_json) {
      try {
        const payload = JSON.parse(msg.event_json);
        switch (msg.event_type) {
          case 'parsed_line':
            if (payload.parsed) lineQueue.push(payload.parsed as ParsedLine);
            break;
          case 'line':
            rawLineQueue.push(payload.line as string);
            break;
          case 'reasoning':
            reasoningQueue.push(payload.text as string);
            break;
        }
      } catch { /* malformed event_json from a misbehaving host - drop it, chunks/final are unaffected */ }
    }
    if (msg?.done) {
      if (!msg?.data_json) {
        finalValue = undefined;
      } else {
        try {
          finalValue = JSON.parse(msg.data_json) as T;
        } catch {
          finalValue = msg.data_json as T;
        }
      }
    }
  });
  call.on('error', (err: any) => {
    detachAbort();
    streamError = streamError ?? err;
    finish();
    emitTrace({ namespace: request.namespace, durationMs: Date.now() - startedAt, attempts: 1, success: false, error: streamError?.message });
    rejectFinal(streamError);
  });
  call.on('end', () => {
    detachAbort();
    finish();
    if (streamError) {
      emitTrace({ namespace: request.namespace, durationMs: Date.now() - startedAt, attempts: 1, success: false, error: streamError?.message });
      rejectFinal(streamError);
    } else {
      emitTrace({ namespace: request.namespace, durationMs: Date.now() - startedAt, attempts: 1, success: true });
      resolveFinal(finalValue as T);
    }
  });

  return {
    chunks: chunkQueue.iterator,
    final,
    lines: lineQueue.iterator,
    rawLines: rawLineQueue.iterator,
    reasoning: reasoningQueue.iterator,
  };
}
