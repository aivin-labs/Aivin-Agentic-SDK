import { EventEmitter } from 'events';
import * as grpc from '@grpc/grpc-js';
import { loadSdkTransportService } from './grpc/loadProto';
import { resolveSdkSecret } from './grpc/GrpcInvoker';
import { SDKClient } from './sdk/SDKClient';
import { invocationStorage } from './sdk/currentInvocation';
import { withTrace, formatTraceForConsole, type InvocationTrace } from './sdk/trace';
import { PluginContext, PluginInput } from './types/SDKTypes';
import { PluginIdentity } from './sdk/SDKClient';
import {
  loadPluginModule,
  resolveTargetFunction as resolveTargetFunctionShared,
  summarizeManifest,
  type LoadedPlugin,
} from './pluginLoader';
import { PluginWorkerHost } from './worker/PluginWorkerHost';

export interface PluginServerConfig {
  plugins_path?: string;
  /** gRPC bind address. Defaults to SDK_GRPC_SERVER_BIND env or '0.0.0.0:50051' (the port the
   * host expects at `${pluginId}:50051` inside the container network). */
  bind_address?: string;
}

/**
 * Plugin Server - the gRPC counterpart of the backend's own inbound call handler.
 *
 * The host calls INTO this server using the SAME `SdkTransportService.Invoke` RPC that this SDK's
 * own SDKClient uses to call OUT to the host - one proto, two directions. `namespace` on an inbound
 * call is just the human-readable "mission" (why this run was triggered), never a function name or
 * plugin id - the host resolves which manifest entry is being invoked long before it ever reaches
 * this container.
 *
 * Entry point resolution:
 * - **Single-function plugin** (`manifest.json` is one object): always resolves the same entry
 *   point in `src/main.ts` (`main`, then default export, then first exported function).
 * - **Multi-function plugin** (`manifest.json` is `{ ...commonFields, plugins: [...] }`, several
 *   entries sharing one container): a real invocation from the host carries the specific entry's
 *   `func` explicitly in
 *   `context.metadata.func` (the host already knows exactly which manifest/plugin id was targeted)
 *   - this server just calls that named export
 *   directly, no local matching needed. `mission`-based matching against the local array manifest's
 *   `id`/`func` only kicks in as a fallback, for `aivin start`'s local dev/curl testing where
 *   there's no real host in the loop to supply an explicit `func`.
 *
 * SANDBOXING: with `AIVIN_SANDBOX_WORKER=true`, the plugin's own `src/main.ts` is never imported
 * here at all - it's loaded and run inside a separate `worker_threads.Worker`
 * (`worker/PluginWorkerRuntime`), which never receives the container's real secret and has its
 * filesystem/child_process/worker access restricted via Node's Permission Model. Every `ctx.sdk.*`
 * call the plugin makes is relayed back to THIS class (`PluginWorkerHost`) over `postMessage`,
 * which is the only thing that ever calls the real `invokeHost`/`invokeHostStream` with the real
 * secret. See `docs/draft/plugins/worker-sandbox.md` for the full design and motivation. Off by
 * default - identical behavior to before when unset.
 */
export class PluginServer extends EventEmitter {
  private readonly config: Required<PluginServerConfig>;
  private readonly sandboxed: boolean;
  private plugin: LoadedPlugin | null = null;
  private workerHost?: PluginWorkerHost;
  private server?: grpc.Server;
  private isRunning = false;

  constructor(config: PluginServerConfig = {}) {
    super();
    this.config = {
      plugins_path: config.plugins_path || '.',
      bind_address: config.bind_address || process.env.SDK_GRPC_SERVER_BIND || '0.0.0.0:50051',
    };
    this.sandboxed = process.env.AIVIN_SANDBOX_WORKER === 'true';
  }

  async start(): Promise<void> {
    const summary = await this.ensureLoaded();

    console.log(`Loaded plugin: ${summary.id} (${summary.name}) v${summary.version}`);

    const ServiceCtor = loadSdkTransportService();
    const server = new grpc.Server();

    server.addService(ServiceCtor.service, {
      Invoke: this.handleInvoke,
    });

    // @grpc/grpc-js >=1.10 starts serving as soon as bindAsync succeeds - calling server.start()
    // afterward is deprecated (and a no-op) in the pinned 1.14.x range.
    await new Promise<void>((resolve, reject) => {
      server.bindAsync(this.config.bind_address, grpc.ServerCredentials.createInsecure(), (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    this.server = server;
    this.isRunning = true;
    console.log(`Plugin gRPC server listening on ${this.config.bind_address}`);
    this.emit('server:started', {
      pluginId: summary.id,
      bindAddress: this.config.bind_address,
    });
  }

  async stop(): Promise<void> {
    await this.workerHost?.stop();
    this.workerHost = undefined;

    if (!this.server) return;

    const server = this.server;
    this.server = undefined;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        server.forceShutdown();
        resolve();
      }, 2000);

      server.tryShutdown(() => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.isRunning = false;
    console.log('Plugin gRPC server stopped');
    this.emit('server:stopped', {});
  }

  /**
   * Load the plugin without starting the gRPC server, and invoke its entry point directly
   * in-process (or, sandboxed, in the worker). Used by LocalTestServer for fast local iteration -
   * no real gRPC round trip, no host required. `ctx.sdk` still works normally if
   * SDK_ENDPOINT/SDK_SECRET point at a real (e.g. local dev) backend; otherwise any `ctx.sdk.*`
   * call throws a clear "not set" error.
   */
  async testInvoke(
    input: PluginInput,
    mockIdentity: Partial<PluginIdentity> = {},
    mission = 'local-test',
  ): Promise<any> {
    await this.ensureLoaded();

    if (this.sandboxed) {
      return this.workerHost!.invokePlugin(mission, input, mockIdentity, mockIdentity.metadata?.['_cap']);
    }

    const sdk = new SDKClient(mockIdentity, { cap: mockIdentity.metadata?.['_cap'] });
    return this.executeHandler(mission, input, { ...mockIdentity, sdk });
  }

  getStatus() {
    const summary = this.sandboxed ? this.workerHost?.getSummary() : this.plugin ? summarizeManifest(this.plugin.manifest) : undefined;
    return {
      plugin_id: summary?.id,
      plugin_name: summary?.name,
      is_running: this.isRunning,
      bind_address: this.config.bind_address,
      uptime: process.uptime(),
      memory_usage: process.memoryUsage(),
    };
  }

  /**
   * Loads the plugin if it isn't already (idempotent, same short-circuit either mode: a plain
   * repeated call - e.g. `testInvoke` when already loaded - does no work). Returns the
   * id/name/version summary either way.
   */
  private async ensureLoaded(): Promise<{ id: string; name: string; version: string }> {
    if (this.sandboxed) {
      if (!this.workerHost) {
        this.workerHost = new PluginWorkerHost({ pluginsPath: this.config.plugins_path });
      }
      return this.workerHost.start();
    }

    if (!this.plugin) {
      this.plugin = await loadPluginModule(this.config.plugins_path);
    }
    return summarizeManifest(this.plugin.manifest);
  }

  /**
   * Re-imports `src/main.ts` (and re-reads `manifest.json`) from disk, replacing whatever is
   * currently loaded - used by `aivin start`'s file-watcher (see `bin/server.mjs`) to hot-reload
   * on save, without restarting the process or dropping the gRPC/HTTP servers already listening.
   *
   * If the reload itself fails (syntax error, missing export, bad manifest JSON mid-edit), the
   * PREVIOUS working plugin is left in place and the error is rethrown to the caller (the
   * watcher) to report - a typo mid-save shouldn't take down an otherwise-running local dev
   * server, and the next invocation should still hit the last-known-good code.
   */
  async reload(): Promise<{ id: string; name: string; version: string }> {
    if (this.sandboxed) {
      if (!this.workerHost) {
        this.workerHost = new PluginWorkerHost({ pluginsPath: this.config.plugins_path });
      }
      return this.workerHost.reload();
    }

    const previous = this.plugin;
    try {
      this.plugin = await loadPluginModule(this.config.plugins_path, true);
      return summarizeManifest(this.plugin.manifest);
    } catch (err) {
      this.plugin = previous;
      throw err;
    }
  }

  private handleInvoke = async (
    call: any,
    callback: (err: any, res: any) => void,
  ): Promise<void> => {
    try {
      const secret = resolveSdkSecret();
      if (secret) {
        const meta = call?.metadata?.get('authorization');
        const token = Array.isArray(meta) ? meta[0] : meta;
        if (!token || token !== `Bearer ${secret}`) {
          callback(null, { success: false, data_json: '', error: 'Unauthorized' });
          return;
        }
      } else {
        console.warn(
          '[PluginServer] SDK_SECRET not set - accepting unauthenticated Invoke calls.',
        );
      }

      const request = call?.request ?? {};
      // "namespace" on an inbound Invoke is the human-readable *mission* (why this run was
      // triggered), not a function name - the host always calls the same single entry point.
      const mission: string = request.namespace ?? '';
      const input: PluginInput = this.safeParseJson(request.params_json);
      const hostContext = this.safeParseJson(request.context_json);

      const identity: PluginIdentity = {
        user: hostContext.user,
        workspace: hostContext.workspace,
        session: hostContext.session,
        org_id: hostContext.org_id,
        client: hostContext.client,
        config: hostContext.config,
        cert: hostContext.cert,
        metadata: hostContext.metadata,
      };

      // Thread the host-minted capability through to any outbound sdk.call() the handler makes
      // during this invocation - resolved server-side, not trusted from anything this process claims.
      const cap = hostContext?.metadata?.['_cap'];

      // Multi-function plugin: the host already resolved exactly which manifest entry this
      // invocation targets and tells us its `func` directly.
      // Absent for a single-function plugin (and for `aivin start`'s local testing).
      const explicitFunc: string | undefined = hostContext?.metadata?.['func'];

      await this.ensureLoaded();

      const result = this.sandboxed
        ? await this.workerHost!.invokePlugin(mission, input, identity, cap, explicitFunc)
        : await this.executeHandler(
            mission,
            input,
            { ...identity, sdk: new SDKClient(identity, { cap }) },
            explicitFunc,
          );

      callback(null, { success: true, data_json: JSON.stringify(result ?? null), error: '' });
    } catch (error) {
      const err = error as Error;
      console.error(`[PluginServer] Invoke failed: ${err.message}`);
      callback(null, { success: false, data_json: '', error: err.message });
    }
  };

  /** Non-sandboxed path only - runs `src/main.ts`'s target function directly in this process. The
   *  sandboxed path's equivalent (`invocationStorage.run` + `withTrace` + reportTrace) runs inside
   *  the worker instead - see `worker/PluginWorkerRuntime`. */
  private async executeHandler(
    mission: string,
    input: PluginInput,
    ctx: PluginContext,
    explicitFunc?: string,
  ): Promise<any> {
    const targetFunction = resolveTargetFunctionShared(this.plugin!, mission, explicitFunc);

    // Bind this invocation's SDKClient to the async context so the default/per-namespace imports
    // from '@aivin-labs/sdk' resolve to it too, not just `ctx.sdk` - see src/sdk/globalSdk.ts. Nested
    // inside `withTrace` so every `sdk.*` call made anywhere during this invocation (including
    // inside nested async work the handler awaits) gets recorded against this invocation's trace,
    // not a sibling one running concurrently in the same process.
    return await invocationStorage.run(ctx.sdk, () =>
      withTrace(mission, () => targetFunction(mission, input, ctx), this.reportTrace),
    );
  }

  /**
   * Fires on every invocation, success or failure - never lets a trace go unreported.
   *
   * `AIVIN_TRACE=false` opts out entirely (e.g. a noisy hot-path plugin in production that doesn't
   * want the console write). Default is "on" everywhere: this is deliberately not gated to dev-only
   * - a trace that only appears locally never catches the intermittent-in-production failure it
   * would have explained. `AIVIN_TRACE_PUBLISH=true` additionally best-effort publishes it via
   * `realtime.publish` so the host CAN surface it in the platform's own execution-flow UI
   * (mirrors the shape the platform's agent-flow view already uses for stage/mission timelines) -
   * off by default since not every deployment has that consumer wired up yet, and every publish is
   * a billable outbound call the plugin didn't ask for.
   *
   * Sandboxed path: `PluginWorkerRuntime` runs the equivalent of this directly inside the worker
   * (same env vars, same behavior) - this method only ever fires for the non-sandboxed path.
   */
  private reportTrace = (trace: InvocationTrace): void => {
    this.emit('invocation:trace', trace);
    if (process.env.AIVIN_TRACE !== 'false') {
      console.log(formatTraceForConsole(trace));
    }
    if (process.env.AIVIN_TRACE_PUBLISH === 'true') {
      const sdk = invocationStorage.getStore();
      sdk
        ?.call('realtime.publish', {
          event: 'plugin.trace',
          data: trace,
          target: 'workspace',
        })
        .catch(() => {
          // Best-effort - a trace-publish failure must never affect the actual invocation result.
        });
    }
  };

  private safeParseJson(raw: string): any {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
}
