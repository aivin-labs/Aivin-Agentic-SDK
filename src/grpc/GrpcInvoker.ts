import * as grpc from '@grpc/grpc-js';
import { loadSdkTransportService } from './loadProto';

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
}

type GrpcInvokeClient = {
  Invoke: (req: any, meta: grpc.Metadata, opts: any, cb: (err: any, res: any) => void) => void;
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
 * container this env var is always injected by the host (DockerHelper), so this fallback never
 * applies there.
 *
 * `sdk.aivin.cloud:443` is production's gRPC entry behind the load balancer - a separate host from
 * `api.aivin.cloud` (the REST API `AIVIN_BASE_URL` points at) and NOT the same path staging uses
 * (`beta-sdk.aivin.vn:50052`, a dedicated Cloudflare Tunnel TLS port - production has no such
 * tunnel, the LB terminates TLS on the standard 443 port instead).
 */
const DEFAULT_ENDPOINT = 'sdk.aivin.cloud:443';

let cachedClient: GrpcInvokeClient | undefined;
let cachedEndpoint: string | undefined;
let warnedDefaultEndpoint = false;

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

function emitTrace(trace: CallTrace): void {
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

/**
 * TLS by default for anything that isn't a local/loopback/container-internal address - this
 * endpoint may now point at a real host over the public internet. Override with
 * SDK_GRPC_TLS=true|false if you need to force one way or the other (e.g. a local endpoint that
 * still requires TLS, or a remote one that's plaintext on a private network).
 */
function buildCredentials(endpoint: string): grpc.ChannelCredentials {
  const override = process.env.SDK_GRPC_TLS;
  const useTls = override ? override.toLowerCase() === 'true' : !isLocalEndpoint(endpoint);
  return useTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
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

function resolveEndpoint(): string {
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
  const secret = process.env.SDK_SECRET;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = request.maxRetries ?? DEFAULT_MAX_RETRIES;

  const attemptOnce = (): Promise<T> => {
    const metadata = new grpc.Metadata();
    if (secret) metadata.set('authorization', `Bearer ${secret}`);
    const deadline = new Date(Date.now() + timeoutMs);

    return new Promise<T>((resolve, reject) => {
      client.Invoke(
        {
          namespace: request.namespace,
          params_json: JSON.stringify(request.params ?? {}),
          context_json: JSON.stringify(request.context ?? {}),
        },
        metadata,
        { deadline },
        (error: any, response: any) => {
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
}

/**
 * Server-streaming counterpart of `invokeHost` - only namespaces the host has registered as
 * streaming-capable (currently `ai.promptStream`) actually stream; see `PluginBridge.callStream`
 * on the backend, which transparently falls back to the unary handler (as one chunk) for anything
 * else. Deliberately has NO automatic retry (unlike `invokeHost`): a stream can be partway through
 * delivering chunks to the caller when a transport error happens, and there's no way to resume or
 * safely re-run a partially-observed stream without risking duplicated/interleaved output.
 */
export function invokeHostStream<T = any>(request: InvokeRequest): StreamHandle<T> {
  const endpoint = resolveEndpoint();
  const client = getClient(endpoint);
  const secret = process.env.SDK_SECRET;
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

  const buffered: string[] = [];
  const waiters: Array<(result: IteratorResult<string, void>) => void> = [];
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

  const pushChunk = (delta: string) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ value: delta, done: false });
    else buffered.push(delta);
  };
  const finish = () => {
    if (ended) return;
    ended = true;
    while (waiters.length) waiters.shift()!({ value: undefined, done: true });
  };

  // Attaching a 'data' listener puts the gRPC ClientReadableStream into flowing mode immediately -
  // this is what makes the stream self-draining regardless of whether the caller ever reads
  // `chunks` (see StreamHandle's doc comment on `final`).
  call.on('data', (msg: any) => {
    if (msg?.success === false) {
      streamError = new Error(msg.error || `gRPC stream invoke returned failure for ${request.namespace}`);
      return;
    }
    if (msg?.delta) pushChunk(msg.delta);
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
    streamError = streamError ?? err;
    finish();
    emitTrace({ namespace: request.namespace, durationMs: Date.now() - startedAt, attempts: 1, success: false, error: streamError?.message });
    rejectFinal(streamError);
  });
  call.on('end', () => {
    finish();
    if (streamError) {
      emitTrace({ namespace: request.namespace, durationMs: Date.now() - startedAt, attempts: 1, success: false, error: streamError?.message });
      rejectFinal(streamError);
    } else {
      emitTrace({ namespace: request.namespace, durationMs: Date.now() - startedAt, attempts: 1, success: true });
      resolveFinal(finalValue as T);
    }
  });

  async function* chunks(): AsyncGenerator<string, void, void> {
    for (;;) {
      if (buffered.length) {
        yield buffered.shift()!;
        continue;
      }
      if (ended) {
        if (streamError) throw streamError;
        return;
      }
      const result = await new Promise<IteratorResult<string, void>>((resolve) => waiters.push(resolve));
      if (result.done) {
        if (streamError) throw streamError;
        return;
      }
      yield result.value as string;
    }
  }

  return { chunks: chunks(), final };
}
