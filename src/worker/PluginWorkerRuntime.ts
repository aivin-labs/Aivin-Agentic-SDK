import { randomUUID } from 'crypto';
import { parentPort, workerData } from 'worker_threads';
import type { InvokeRequest, StreamHandle } from '../grpc/GrpcInvoker';
import { emitTrace } from '../grpc/GrpcInvoker';
import { SDKClient, type PluginIdentity } from '../sdk/SDKClient';
import { invocationStorage } from '../sdk/currentInvocation';
import { withTrace, formatTraceForConsole, type InvocationTrace } from '../sdk/trace';
import { loadPluginModule, resolveTargetFunction, summarizeManifest, type LoadedPlugin } from '../pluginLoader';
import {
  serializeError,
  reviveError,
  type HostToWorkerMessage,
  type WorkerToHostMessage,
  type InvokeMessage,
} from './protocol';

/**
 * Entry point run inside the sandboxed `worker_threads.Worker` spawned by `PluginWorkerHost` when
 * `AIVIN_SANDBOX_WORKER=true`. Loads and runs the plugin's own `src/main.ts` exactly like
 * `PluginServer` does in the non-sandboxed path (same `loadPluginModule`/`resolveTargetFunction`/
 * `withTrace` from `pluginLoader.ts`/`sdk/trace.ts`) - the only structural difference is that
 * `ctx.sdk.*`'s transport (`SDKClientOptions.invoke`/`invokeStream`) is swapped for
 * `remoteInvoke`/`remoteInvokeStream` below, which relay over `parentPort` instead of dialing the
 * real backend directly. This worker never receives `SDK_SECRET_FILE`/`SDK_SECRET` (see
 * `PluginWorkerHost`'s filtered `env`) and has no way to reach the real transport itself.
 *
 * `console.*` output needs no relay of its own - Node pipes a Worker's stdout/stderr to the
 * parent process's real stdout/stderr by default, so `sdk.log()`/plain `console.log()` (captured
 * by `trace.ts`'s own `installConsoleCapture`, which runs the moment this file imports `trace.ts`,
 * same as it does in the non-sandboxed path) show up in the container's real logs unchanged.
 */

if (!parentPort) {
  throw new Error('PluginWorkerRuntime must be run as a worker_threads.Worker, not the main thread.');
}
const port = parentPort;

const { pluginsPath } = workerData as { pluginsPath: string };

let loadedPlugin: LoadedPlugin | null = null;

const pendingCalls = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void; namespace: string; startedAt: number }>();
const pendingStreams = new Map<
  string,
  { onChunk: (delta: string) => void; onEnd: (final: any) => void; onError: (err: Error) => void }
>();

/** `SDKClientOptions.invoke` override - posts the call to the host (the only thing holding the
 *  real secret) and awaits its reply instead of dialing the backend directly. */
function remoteInvoke<T = any>(request: InvokeRequest): Promise<T> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  return new Promise<T>((resolve, reject) => {
    pendingCalls.set(requestId, { resolve, reject, namespace: request.namespace, startedAt });
    port.postMessage({ type: 'sdk.call', requestId, request } satisfies WorkerToHostMessage);
  });
}

/** `SDKClientOptions.invokeStream` override - same buffered/waiters pattern `invokeHostStream`
 *  itself uses in `GrpcInvoker.ts`, just fed by `sdk.stream.*` messages from the host instead of
 *  real gRPC stream events. */
function remoteInvokeStream<T = any>(request: InvokeRequest): StreamHandle<T> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const buffered: string[] = [];
  const waiters: Array<(result: IteratorResult<string, void>) => void> = [];
  let ended = false;
  let streamError: Error | undefined;
  let finalValue: T | undefined;
  let resolveFinal!: (value: T) => void;
  let rejectFinal!: (err: any) => void;
  const final = new Promise<T>((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });
  final.catch(() => {});

  const finish = () => {
    if (ended) return;
    ended = true;
    while (waiters.length) waiters.shift()!({ value: undefined, done: true });
  };

  pendingStreams.set(requestId, {
    onChunk: (delta) => {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: delta, done: false });
      else buffered.push(delta);
    },
    onEnd: (finalData) => {
      finalValue = finalData as T;
      finish();
      resolveFinal(finalValue as T);
      emitTrace({ namespace: request.namespace, durationMs: Date.now() - startedAt, attempts: 1, success: true });
    },
    onError: (err) => {
      streamError = err;
      finish();
      rejectFinal(err);
      emitTrace({
        namespace: request.namespace,
        durationMs: Date.now() - startedAt,
        attempts: 1,
        success: false,
        error: err.message,
      });
    },
  });

  port.postMessage({ type: 'sdk.stream.start', requestId, request } satisfies WorkerToHostMessage);

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

/** Mirrors `PluginServer.reportTrace` (minus the `EventEmitter` emit, which has no equivalent
 *  here) - see that method's doc comment for the env vars this respects. */
function reportTrace(trace: InvocationTrace): void {
  if (process.env.AIVIN_TRACE !== 'false') {
    console.log(formatTraceForConsole(trace));
  }
  if (process.env.AIVIN_TRACE_PUBLISH === 'true') {
    const sdk = invocationStorage.getStore();
    sdk
      ?.call('realtime.publish', { event: 'plugin.trace', data: trace, target: 'workspace' })
      .catch(() => {
        // Best-effort - a trace-publish failure must never affect the actual invocation result.
      });
  }
}

async function handleInvoke(msg: InvokeMessage): Promise<void> {
  try {
    if (!loadedPlugin) {
      loadedPlugin = await loadPluginModule(pluginsPath);
    }
    const targetFunction = resolveTargetFunction(loadedPlugin, msg.mission, msg.explicitFunc);
    const sdk = new SDKClient(msg.identity as PluginIdentity, {
      cap: msg.cap,
      invoke: remoteInvoke,
      invokeStream: remoteInvokeStream,
    });
    const ctx = { ...msg.identity, sdk };

    const result = await invocationStorage.run(sdk, () =>
      withTrace(msg.mission, () => targetFunction(msg.mission, msg.input, ctx as any), reportTrace),
    );
    port.postMessage({ type: 'invoke.done', requestId: msg.requestId, ok: true, result } satisfies WorkerToHostMessage);
  } catch (err) {
    port.postMessage({
      type: 'invoke.done',
      requestId: msg.requestId,
      ok: false,
      error: serializeError(err),
    } satisfies WorkerToHostMessage);
  }
}

port.on('message', (msg: HostToWorkerMessage) => {
  switch (msg.type) {
    case 'invoke':
      void handleInvoke(msg);
      break;
    case 'sdk.call.result': {
      const pending = pendingCalls.get(msg.requestId);
      if (!pending) return;
      pendingCalls.delete(msg.requestId);
      if (msg.ok) {
        pending.resolve(msg.data);
        emitTrace({ namespace: pending.namespace, durationMs: Date.now() - pending.startedAt, attempts: 1, success: true });
      } else {
        const err = reviveError(msg.error);
        pending.reject(err);
        emitTrace({
          namespace: pending.namespace,
          durationMs: Date.now() - pending.startedAt,
          attempts: 1,
          success: false,
          error: err.message,
        });
      }
      break;
    }
    case 'sdk.stream.chunk':
      pendingStreams.get(msg.requestId)?.onChunk(msg.delta);
      break;
    case 'sdk.stream.end': {
      const pending = pendingStreams.get(msg.requestId);
      pendingStreams.delete(msg.requestId);
      pending?.onEnd(msg.final);
      break;
    }
    case 'sdk.stream.error': {
      const pending = pendingStreams.get(msg.requestId);
      pendingStreams.delete(msg.requestId);
      pending?.onError(reviveError(msg.error));
      break;
    }
  }
});

// Eager load at startup, mirroring `PluginServer.start()`'s eager `loadPluginModule()` call - a
// broken plugin (syntax error, missing export) should fail fast, not on the first invocation.
loadPluginModule(pluginsPath)
  .then((plugin) => {
    loadedPlugin = plugin;
    port.postMessage({ type: 'ready', summary: summarizeManifest(plugin.manifest) } satisfies WorkerToHostMessage);
  })
  .catch((err) => {
    port.postMessage({ type: 'load.error', error: serializeError(err) } satisfies WorkerToHostMessage);
  });
