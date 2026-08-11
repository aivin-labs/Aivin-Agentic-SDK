import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as grpc from '@grpc/grpc-js';
import { loadSdkTransportService } from './grpc/loadProto';
import { resolveSdkSecret } from './grpc/GrpcInvoker';
import { SDKClient } from './sdk/SDKClient';
import { invocationStorage } from './sdk/currentInvocation';
import { withTrace, formatTraceForConsole, type InvocationTrace } from './sdk/trace';
import { PluginManifest, MultiFunctionManifestEntry, flattenManifestFile } from './types/PluginTypes';
import { PluginContext, PluginInput } from './types/SDKTypes';
import { PluginIdentity } from './sdk/SDKClient';

interface LoadedPlugin {
  /** A plain object for a single-function plugin, or - once `manifest.json`'s on-disk
   *  `{ ...commonFields, plugins: [...] }` shape has been flattened - an array (each entry naming
   *  which export in src/main.ts implements it via `func`) for a multi-function plugin. */
  manifest: PluginManifest | MultiFunctionManifestEntry[];
  /** The raw `src/main.ts` module namespace - kept as-is (not pre-resolved to a single function)
   *  so multi-function plugins can look up any of its named exports by name. */
  handler: any;
}

export interface PluginServerConfig {
  plugins_path?: string;
  /** gRPC bind address. Defaults to SDK_GRPC_SERVER_BIND env or '0.0.0.0:50051' (the port the
   * host's DockerHelper/PluginRunner expects at `${pluginId}:50051` inside the container network). */
  bind_address?: string;
}

/**
 * Plugin Server - the gRPC counterpart of the backend's GrpcSDKServer/GrpcTransportAdapter.
 *
 * The host calls INTO this server (see PluginRunner.handleDockerRuntime on the backend) using
 * the SAME `SdkTransportService.Invoke` RPC that this SDK's own SDKClient uses to call OUT to the
 * host - one proto, two directions. `namespace` on an inbound call is just the human-readable
 * "mission" (why this run was triggered), never a function name or plugin id - the host resolves
 * which manifest entry is being invoked long before it ever reaches this container.
 *
 * Entry point resolution:
 * - **Single-function plugin** (`manifest.json` is one object): always resolves the same entry
 *   point in `src/main.ts` (`main`, then default export, then first exported function).
 * - **Multi-function plugin** (`manifest.json` is `{ ...commonFields, plugins: [...] }`, several
 *   entries sharing one container): a real invocation from the host carries the specific entry's
 *   `func` explicitly in
 *   `context.metadata.func` (the host already knows exactly which manifest/plugin id was targeted -
 *   see PluginRunner.handleDockerRuntime on the backend) - this server just calls that named export
 *   directly, no local matching needed. `mission`-based matching against the local array manifest's
 *   `id`/`func` only kicks in as a fallback, for `aivin start`'s local dev/curl testing where
 *   there's no real host in the loop to supply an explicit `func`.
 */
export class PluginServer extends EventEmitter {
  private readonly config: Required<PluginServerConfig>;
  private plugin: LoadedPlugin | null = null;
  private server?: grpc.Server;
  private isRunning = false;

  constructor(config: PluginServerConfig = {}) {
    super();
    this.config = {
      plugins_path: config.plugins_path || '.',
      bind_address: config.bind_address || process.env.SDK_GRPC_SERVER_BIND || '0.0.0.0:50051',
    };
  }

  async start(): Promise<void> {
    await this.loadPlugin();
    if (!this.plugin) {
      throw new Error('No plugin loaded. Make sure manifest.json and src/main.ts exist.');
    }

    const summary = this.summarizeManifest();
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
   * in-process. Used by LocalTestServer for fast local iteration - no real gRPC round trip, no
   * host required. `ctx.sdk` still works normally if SDK_ENDPOINT/SDK_SECRET point at
   * a real (e.g. local dev) backend; otherwise any `ctx.sdk.*` call throws a clear "not set" error.
   */
  async testInvoke(
    input: PluginInput,
    mockIdentity: Partial<PluginIdentity> = {},
    mission = 'local-test',
  ): Promise<any> {
    if (!this.plugin) {
      await this.loadPlugin();
    }
    const sdk = new SDKClient(mockIdentity, { cap: mockIdentity.metadata?.['_cap'] });
    return this.executeHandler(mission, input, { ...mockIdentity, sdk });
  }

  getStatus() {
    const summary = this.plugin ? this.summarizeManifest() : undefined;
    return {
      plugin_id: summary?.id,
      plugin_name: summary?.name,
      is_running: this.isRunning,
      bind_address: this.config.bind_address,
      uptime: process.uptime(),
      memory_usage: process.memoryUsage(),
    };
  }

  /** Display-friendly id/name/version for logging - handles both single-object and
   *  multi-function-array manifest shapes. */
  private summarizeManifest(): { id: string; name: string; version: string } {
    const manifest = this.plugin!.manifest;
    if (Array.isArray(manifest)) {
      return {
        id: manifest.map((m) => m.id).join(', '),
        name: `${manifest.length} functions (${manifest.map((m) => m.func).join(', ')})`,
        version: manifest[0]?.version ?? '0.0.0',
      };
    }
    return { id: manifest.id, name: manifest.name, version: manifest.version ?? '0.0.0' };
  }

  /**
   * Re-imports `src/main.ts` (and re-reads `manifest.json`) from disk, replacing whatever is
   * currently loaded - used by `aivin start`'s file-watcher (see `bin/server.mjs`) to hot-reload
   * on save, without restarting the process or dropping the gRPC/HTTP servers already listening.
   *
   * If the reload itself fails (syntax error, missing export, bad manifest JSON mid-edit), the
   * PREVIOUS working `this.plugin` is left in place and the error is rethrown to the caller (the
   * watcher) to report - a typo mid-save shouldn't take down an otherwise-running local dev
   * server, and the next invocation should still hit the last-known-good code.
   */
  async reload(): Promise<{ id: string; name: string; version: string }> {
    const previous = this.plugin;
    try {
      await this.loadPlugin(true);
      return this.summarizeManifest();
    } catch (err) {
      this.plugin = previous;
      throw err;
    }
  }

  private async loadPlugin(cacheBust = false): Promise<void> {
    const pluginsPath = this.config.plugins_path;
    const manifestPath = path.join(pluginsPath, 'manifest.json');
    const entryPath = path.join(pluginsPath, 'src', 'main.ts');

    if (!fs.existsSync(manifestPath) || !fs.existsSync(entryPath)) {
      throw new Error(
        `Plugin files not found. Expected manifest.json and src/main.ts in: ${pluginsPath}`,
      );
    }

    // `manifest.json` may be authored as { ...commonFields, plugins: [...] } for a multi-function
    // plugin (shared fields written once) - flatten it back into a plain object or a flat array
    // before anything else here needs to reason about its shape.
    const manifest = flattenManifestFile(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));

    // Dynamic import to load src/main.ts as native ESM/TS (Node's native TypeScript support,
    // >=22.6). Routed through `new Function` so TS's CommonJS downlevel of `import()` (a
    // require()-based helper that can't load a real ESM/.ts file) is bypassed - see the SDK
    // README for the full rationale.
    const absolutePath = path.resolve(entryPath);
    // Node's ESM module cache is keyed by the full specifier (including query string), not just
    // the file path - `?t=<timestamp>` on a `reload()` forces a genuinely fresh import instead of
    // silently handing back the stale, already-cached module for the same `file://` path. Omitted
    // on the normal first load so a plain `require.resolve`-style repeated call (e.g. `testInvoke`
    // when `this.plugin` is already set) still short-circuits without ever reaching this at all.
    const importPath = pathToFileURL(absolutePath).href + (cacheBust ? `?t=${Date.now()}` : '');
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    // Kept as the raw module namespace (not pre-resolved to `.default`) - a multi-function plugin
    // needs to look up ANY of its named exports by name, not just one.
    const handler = await dynamicImport(importPath);

    this.plugin = { manifest, handler };
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
      // during this invocation - see GrpcCapabilityStore on the backend for why this matters.
      const cap = hostContext?.metadata?.['_cap'];
      const sdk = new SDKClient(identity, { cap });

      // Multi-function plugin: the host already resolved exactly which manifest entry this
      // invocation targets and tells us its `func` directly - see PluginRunner.handleDockerRuntime
      // on the backend. Absent for a single-function plugin (and for `aivin start`'s local testing).
      const explicitFunc: string | undefined = hostContext?.metadata?.['func'];

      const result = await this.executeHandler(mission, input, { ...identity, sdk }, explicitFunc);

      callback(null, { success: true, data_json: JSON.stringify(result ?? null), error: '' });
    } catch (error) {
      const err = error as Error;
      console.error(`[PluginServer] Invoke failed: ${err.message}`);
      callback(null, { success: false, data_json: '', error: err.message });
    }
  };

  private async executeHandler(
    mission: string,
    input: PluginInput,
    ctx: PluginContext,
    explicitFunc?: string,
  ): Promise<any> {
    const targetFunction = this.resolveTargetFunction(mission, explicitFunc);

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

  /**
   * Resolves which exported function in `src/main.ts` to call for this invocation.
   *
   * - `explicitFunc` given (a real host invocation of a multi-function plugin - see
   *   `handleInvoke`): calls `handler[explicitFunc]` directly. No local manifest lookup needed -
   *   the host already resolved which entry this is.
   * - plugins[] manifest (array) with no `explicitFunc` - `aivin start`'s local dev/curl testing,
   *   no real host in the loop: a single-entry manifest resolves straight to its one entry;
   *   otherwise finds the entry whose `id` matches `mission`, or failing that whose `func` matches
   *   `mission` directly, and calls its `func`.
   * - Single-function plugin (manifest is one object): `main` export, then default export, then
   *   the first exported function - `mission` is just a human-readable label here, not routing.
   */
  private resolveTargetFunction(
    mission: string,
    explicitFunc?: string,
  ): (mission: string, input: PluginInput, ctx: PluginContext) => any {
    const handler = this.plugin!.handler;
    const manifest = this.plugin!.manifest;

    if (explicitFunc) {
      const fn = handler[explicitFunc];
      if (typeof fn !== 'function') {
        throw new Error(
          `Host requested func "${explicitFunc}", but src/main.ts does not export a function with that name.`,
        );
      }
      return fn;
    }

    if (Array.isArray(manifest)) {
      // A single-entry plugins[] manifest (the default `aivin create`/`aivin init` scaffold) is
      // unambiguous - resolve to its one entry no matter what `mission` says, so plain local
      // curl testing works without the caller knowing the entry's id/func.
      const entry =
        manifest.length === 1
          ? manifest[0]
          : (manifest.find((m) => m.id === mission) ?? manifest.find((m) => m.func === mission));
      if (!entry) {
        const known = manifest.map((m) => `${m.id} -> ${m.func}`).join(', ');
        throw new Error(
          `No function matches "${mission}" in this multi-function plugin. Known id -> func mappings: ${known}`,
        );
      }
      const fn = handler[entry.func];
      if (typeof fn !== 'function') {
        throw new Error(
          `manifest.json declares func "${entry.func}" for plugin "${entry.id}", but src/main.ts does not export a function with that name.`,
        );
      }
      return fn;
    }

    if (typeof handler.main === 'function') return handler.main;
    if (typeof handler.default === 'function') return handler.default;
    const firstFn = Object.keys(handler).find((key) => typeof handler[key] === 'function');
    if (firstFn) return handler[firstFn];

    throw new Error(`No executable entry point found in plugin ${manifest.name}`);
  }

  private safeParseJson(raw: string): any {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
}
