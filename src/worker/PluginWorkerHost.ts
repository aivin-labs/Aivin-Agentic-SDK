import { randomUUID } from 'crypto';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { invokeHost, invokeHostStream, type InvokeRequest, type StreamHandle } from '../grpc/GrpcInvoker';
import type { PluginIdentity } from '../sdk/SDKClient';
import type { PluginInput } from '../types/SDKTypes';
import { serializeError, reviveError, type HostToWorkerMessage, type WorkerToHostMessage } from './protocol';

export interface PluginWorkerHostConfig {
  pluginsPath: string;
  /** Transport override for tests - defaults to the real `invokeHost`/`invokeHostStream`, exactly
   *  like `SDKClientOptions` does. Not meant to be set in production. */
  invoke?: <T = any>(request: InvokeRequest) => Promise<T>;
  invokeStream?: <T = any>(request: InvokeRequest) => StreamHandle<T>;
}

/** Env vars forwarded into the worker's `process.env` as-is. Everything else needs to come through
 *  the worker explicitly (e.g. as manifest-declared plugin config) - the worker does NOT get a
 *  copy of the full container environment the way a plain `new Worker()` would default to. */
const ENV_ALLOWLIST = ['NODE_ENV'];

function buildFilteredEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key] as string;
  }
  return env;
}

/**
 * Main-thread half of the plugin sandbox (`AIVIN_SANDBOX_WORKER=true`) - owns the
 * `worker_threads.Worker` running the plugin's own code (`worker/PluginWorkerRuntime`) and is the
 * only thing that ever calls the real `invokeHost`/`invokeHostStream` (with the real secret) on
 * its behalf. See `PluginServer`'s class doc and `docs/draft/plugins/worker-sandbox.md`.
 */
export class PluginWorkerHost {
  private readonly pluginsPath: string;
  private readonly invoke: <T = any>(request: InvokeRequest) => Promise<T>;
  private readonly invokeStream: <T = any>(request: InvokeRequest) => StreamHandle<T>;

  private worker?: Worker;
  private lastSummary?: { id: string; name: string; version: string };
  private startPromise?: Promise<{ id: string; name: string; version: string }>;
  private readonly pendingInvokes = new Map<
    string,
    { resolve: (result: any) => void; reject: (err: Error) => void }
  >();

  constructor(config: PluginWorkerHostConfig) {
    this.pluginsPath = path.resolve(config.pluginsPath);
    this.invoke = config.invoke ?? invokeHost;
    this.invokeStream = config.invokeStream ?? invokeHostStream;
  }

  getSummary(): { id: string; name: string; version: string } | undefined {
    return this.lastSummary;
  }

  /** Spawns the worker if needed and waits for its eager plugin load to finish (or fail) -
   *  idempotent, mirrors `PluginServer`'s non-sandboxed `ensureLoaded()`. */
  async start(): Promise<{ id: string; name: string; version: string }> {
    if (this.worker && this.startPromise) return this.startPromise;
    this.startPromise = this.spawn();
    return this.startPromise;
  }

  /** Terminates the current worker and spawns a fresh one - a fresh `Worker` has an empty module
   *  cache by construction, which is strictly more correct than the non-sandboxed path's
   *  cache-busting `?t=timestamp` re-import trick (see `pluginLoader.loadPluginModule`). Worker
   *  startup cost is small enough for this to still be fine for `aivin start`'s dev hot-reload. */
  async reload(): Promise<{ id: string; name: string; version: string }> {
    await this.stop();
    return this.start();
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    this.startPromise = undefined;
    if (!worker) return;

    const pendingError = new Error('Plugin worker stopped while this call was still in flight.');
    for (const pending of this.pendingInvokes.values()) pending.reject(pendingError);
    this.pendingInvokes.clear();

    await worker.terminate();
  }

  /** Sends one invocation to the worker and resolves/rejects with its result - used by both
   *  `PluginServer.testInvoke` (local HTTP shim) and `handleInvoke` (real gRPC calls). */
  async invokePlugin(
    mission: string,
    input: PluginInput,
    identity: Partial<PluginIdentity>,
    cap?: string,
    explicitFunc?: string,
  ): Promise<any> {
    await this.start();
    const worker = this.worker!;
    const requestId = randomUUID();

    return new Promise((resolve, reject) => {
      this.pendingInvokes.set(requestId, { resolve, reject });
      worker.postMessage({
        type: 'invoke',
        requestId,
        mission,
        input,
        identity,
        cap,
        explicitFunc,
      } satisfies HostToWorkerMessage);
    });
  }

  private spawn(): Promise<{ id: string; name: string; version: string }> {
    const runtimeEntry = path.join(__dirname, 'PluginWorkerRuntime.js');
    // dist/worker/PluginWorkerHost.js -> package root, so the SDK's own compiled files/deps stay
    // readable regardless of where they physically live relative to the plugin's own directory.
    const sdkRoot = path.resolve(__dirname, '..', '..');

    const worker = new Worker(runtimeEntry, {
      workerData: { pluginsPath: this.pluginsPath },
      env: buildFilteredEnv(),
      execArgv: [
        '--permission',
        `--allow-fs-read=${this.pluginsPath}`,
        `--allow-fs-read=${sdkRoot}`,
        // No --allow-fs-write, --allow-child-process, or --allow-worker - omission denies them.
      ],
    });
    this.worker = worker;

    return new Promise((resolve, reject) => {
      const onMessage = (msg: WorkerToHostMessage) => {
        if (msg.type === 'ready') {
          this.lastSummary = msg.summary;
          resolve(msg.summary);
          return;
        }
        if (msg.type === 'load.error') {
          reject(reviveError(msg.error));
          return;
        }
        this.handleWorkerMessage(msg);
      };
      worker.on('message', onMessage);
      worker.on('error', (err) => {
        reject(err);
        const failure = err instanceof Error ? err : new Error(String(err));
        for (const pending of this.pendingInvokes.values()) pending.reject(failure);
        this.pendingInvokes.clear();
      });
      worker.on('exit', (code) => {
        if (code === 0) return;
        const err = new Error(`Plugin worker exited unexpectedly (code ${code}).`);
        for (const pending of this.pendingInvokes.values()) pending.reject(err);
        this.pendingInvokes.clear();
      });
    });
  }

  private handleWorkerMessage(msg: WorkerToHostMessage): void {
    switch (msg.type) {
      case 'sdk.call':
        void this.relayCall(msg.requestId, msg.request);
        break;
      case 'sdk.stream.start':
        void this.relayStream(msg.requestId, msg.request);
        break;
      case 'invoke.done': {
        const pending = this.pendingInvokes.get(msg.requestId);
        if (!pending) return;
        this.pendingInvokes.delete(msg.requestId);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(reviveError(msg.error));
        break;
      }
    }
  }

  /** Runs the plugin's `ctx.sdk.*` call for real (the real secret is only ever used here, on the
   *  main thread) and relays the outcome back to the worker. */
  private async relayCall(requestId: string, request: InvokeRequest): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    try {
      const data = await this.invoke(request);
      worker.postMessage({ type: 'sdk.call.result', requestId, ok: true, data } satisfies HostToWorkerMessage);
    } catch (err) {
      worker.postMessage({
        type: 'sdk.call.result',
        requestId,
        ok: false,
        error: serializeError(err),
      } satisfies HostToWorkerMessage);
    }
  }

  private async relayStream(requestId: string, request: InvokeRequest): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    try {
      const handle = this.invokeStream(request);
      // `chunks`/`lines`/`rawLines`/`reasoning` are four independent generators over the same
      // underlying stream (see `StreamHandle`'s doc comments in `GrpcInvoker.ts`) - drained
      // concurrently here so none of them is gated behind fully relaying another first.
      const relayChunks = (async () => {
        for await (const delta of handle.chunks) {
          worker.postMessage({ type: 'sdk.stream.chunk', requestId, delta } satisfies HostToWorkerMessage);
        }
      })();
      const relayLines = (async () => {
        for await (const parsed of handle.lines) {
          worker.postMessage({ type: 'sdk.stream.parsedLine', requestId, parsed } satisfies HostToWorkerMessage);
        }
      })();
      const relayRawLines = (async () => {
        for await (const line of handle.rawLines) {
          worker.postMessage({ type: 'sdk.stream.rawLine', requestId, line } satisfies HostToWorkerMessage);
        }
      })();
      const relayReasoning = (async () => {
        for await (const text of handle.reasoning) {
          worker.postMessage({ type: 'sdk.stream.reasoning', requestId, text } satisfies HostToWorkerMessage);
        }
      })();
      await Promise.all([relayChunks, relayLines, relayRawLines, relayReasoning]);
      const final = await handle.final;
      worker.postMessage({ type: 'sdk.stream.end', requestId, final } satisfies HostToWorkerMessage);
    } catch (err) {
      worker.postMessage({
        type: 'sdk.stream.error',
        requestId,
        error: serializeError(err),
      } satisfies HostToWorkerMessage);
    }
  }
}
