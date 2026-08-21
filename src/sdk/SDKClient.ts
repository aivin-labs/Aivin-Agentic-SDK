import { z } from 'zod';
import { invokeHost, invokeHostStream, type InvokeRequest, type StreamHandle } from '../grpc/GrpcInvoker';
import {
  addRowParamsSchema,
  batchDeleteRowsParamsSchema,
  batchUpdateByAIParamSchema,
  batchUpdateRowsParamsSchema,
  bulkAddRowsParamsSchema,
  createJobParamsSchema,
  createTableParamsSchema,
  deduplicateTableParamsSchema,
  backfillColumnParamsSchema,
  deleteJobParamsSchema,
  deleteTableParamsSchema,
  ensureTableParamsSchema,
  executeByIdParamSchema,
  formatRowsForContextParamsSchema,
  getAllTablesParamsSchema,
  getJobsParamsSchema,
  getRowsParamsSchema,
  getTableParamsSchema,
  getTablesParamsSchema,
  pushNotificationParamsSchema,
  removeParamsSchema,
  rollbackParamSchema,
  searchSemanticParamsSchema,
  smartQueryParamSchema,
  storeAggregateParamsSchema,
  storeBulkParamsSchema,
  storeCountParamsSchema,
  storeCursorParamsSchema,
  storeDeleteParamsSchema,
  storeGetLinksParamsSchema,
  storeGetParamsSchema,
  storeJoinParamsSchema,
  storeLinkParamsSchema,
  storeQueryParamsSchema,
  storeSearchParamsSchema,
  storeSetParamsSchema,
  storeTransactionParamsSchema,
  storeUnlinkParamsSchema,
  tableIdScopedParamsSchema,
  runFlowParamsSchema,
  updateJobParamsSchema,
  updateTableParamsSchema,
  uploadParamsSchema,
  validateParams,
} from './validation';
import type {
  Agent,
  AgentReplyOptions,
  AutomationJob,
  ClientLogEvent,
  ConnectionInfo,
  FlowStage,
  FlowStepResult,
  LLMPromptOptions,
  MediaGenerationResult,
  MediaItem,
  MediaPromptOptions,
  MessageListener,
  MessageSession,
  ParsedLine,
  PluginContext,
  ResourceMeta,
  RunFlowContext,
  Task,
  User,
  Workspace,
  WorkflowGraph,
} from '../types/SDKTypes';
import type { PluginManifest } from '../types/PluginTypes';

export interface SDKClientOptions {
  /** Per-invocation capability token minted by the host (context.metadata._cap on the inbound Invoke). */
  cap?: string;
  /** Default timeout for `call()` when the caller doesn't override it. */
  defaultTimeoutMs?: number;
  /** Transport override, real gRPC by default - lets tests inject a fake transport instead of
   *  mocking the proto/network layer. Not meant to be set in production plugin code. */
  invoke?: <T = any>(request: InvokeRequest) => Promise<T>;
  /** Streaming transport override, mirrors `invoke` - lets tests inject a fake stream instead of a
   *  real gRPC server-streaming call. Not meant to be set in production plugin code. */
  invokeStream?: <T = any>(request: InvokeRequest) => StreamHandle<T>;
}

/** Identity fields needed to build an SDKClient - `PluginContext` minus the `sdk` field itself
 * (which *is* the SDKClient being constructed - can't require an instance of itself as input). */
export type PluginIdentity = Omit<PluginContext, 'sdk'>;

/**
 * Heuristic used by `a2a()`/`agent.delegate()` to tell an actual agent ID apart from a natural
 * language search query, without a network round-trip. Real agent IDs are short hex/UUID-like
 * strings with no spaces; anything else (contains a space, too long, or has non-hex characters)
 * is treated as a search query and resolved via `workspace.searchAgents` first. Exported as a pure
 * function so this decision is unit-testable without mocking the gRPC transport.
 */
export function looksLikeAgentId(target: string): boolean {
  return !target.includes(' ') && target.length <= 32 && /^[0-9a-fA-F-]+$/.test(target);
}

const LOG_LEVEL_COLOR: Record<'info' | 'warn' | 'error', string> = {
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};
const ANSI_RESET = '\x1b[0m';
const ANSI_DIM = '\x1b[2m';

/** `HH:MM:SS.mmm`, local time - matches what a dev staring at their own terminal wants (log
 *  ordering/latency at a glance), not a machine-parseable timestamp. */
function logTimestamp(): string {
  const d = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Color is opt-out, not opt-in, but only ever kicks in where it's safe: a real local TTY that
 * isn't production. `sdk.log()` runs unmodified inside a production Docker container too (same
 * code path as local `aivin start`) - ANSI codes in *that* stdout would pollute whatever log
 * collector is scraping it, so this stays plain there even if someone sets NODE_ENV wrong. Piped
 * output (`| tee`, CI) also loses TTY-ness and falls back to plain automatically.
 */
function logColorEligible(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.SDK_LOG_COLOR !== 'false' &&
    !!process.stdout.isTTY
  );
}

/** Default timeout for `agent.runFlow`/`promptAgentic`/`promptAction`/`promptAssistant`/`prompt` -
 *  see `SDKClient.callWithOptionalEvents`'s doc for why these need more than the general 30s
 *  `defaultTimeoutMs`. Overridable per call via `opts.timeoutMs`. */
const LONG_RUNNING_DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * Client-side implementation of the platform's unified SDK surface.
 *
 * Mirrors the backend's own plugin-contract type declaration (the single source of truth for what a
 * plugin can call). Every method - generic `call()` and the typed sugar objects below - goes
 * through the same gRPC `Invoke` RPC (`namespace.method`, params, context), matching exactly how
 * the host dispatches inbound calls. The `cap` token is threaded into `context.metadata._cap` on
 * every outbound call so the host can resolve this invocation's real tenant/workspace/session
 * identity instead of trusting anything this process claims about itself.
 */
export class SDKClient {
  private readonly cap?: string;
  private readonly defaultTimeoutMs: number;
  private readonly invoke: <T = any>(request: InvokeRequest) => Promise<T>;
  private readonly invokeStream: <T = any>(request: InvokeRequest) => StreamHandle<T>;

  constructor(
    private readonly context: PluginIdentity,
    options: SDKClientOptions = {},
  ) {
    this.cap = options.cap;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.invoke = options.invoke ?? invokeHost;
    this.invokeStream = options.invokeStream ?? invokeHostStream;
  }

  private buildContext(): Record<string, any> {
    return {
      user: this.context.user,
      workspace: this.context.workspace,
      session: this.context.session,
      org_id: this.context.org_id,
      client: this.context.client,
      config: this.context.config,
      metadata: {
        ...(this.context.metadata ?? {}),
        ...(this.cap ? { _cap: this.cap } : {}),
      },
    };
  }

  /** Generic escape hatch: call any host namespace directly. `signal` cancels the underlying gRPC
   *  call when aborted - see `InvokeRequest.signal`'s doc comment (`GrpcInvoker.ts`) for mechanics. */
  async call<T = any>(func: string, params?: any, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
    return this.invoke<T>({
      namespace: func,
      params,
      context: this.buildContext(),
      timeoutMs: timeoutMs ?? this.defaultTimeoutMs,
      signal,
    });
  }

  /**
   * Gọi 1 plugin khác theo id thật, KHÔNG qua cách ghép chuỗi "pluginId.purpose" mà `call()` dùng
   * cho namespace host (`ai.prompt`, `table.createTable`...) - `plugin_id` trong hệ thống này
   * thường tự chứa dấu chấm (`official.xxx`, `analyst.xxx`), nên ghép mission vào cùng string sẽ
   * tách sai. `mission`/`params`/`opts` đi qua field JSON riêng, dispatch qua route cố định
   * `plugin.trigger` phía host (xem `PluginTriggerSDK.ts`).
   *
   * `opts.workspaceId`/`agentId`/`sessionId` là optional target override - không truyền thì chạy
   * đúng workspace/agent/session hiện tại (ambient, y hệt `call()`). Có truyền thì host tự verify
   * lại quyền của danh tính THẬT (từ cap token, không phải tham số này) trên workspace target
   * trước khi cho chạy - không có cách nào tự khai `ctx` để giả mạo quyền qua tham số.
   */
  async triggerPlugin<T = any>(
    pluginId: string,
    mission: string,
    params?: Record<string, any>,
    opts?: { workspaceId?: string; agentId?: string; sessionId?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    return this.call<T>(
      'plugin.trigger',
      {
        plugin_id: pluginId,
        mission,
        arguments: params,
        workspace_id: opts?.workspaceId,
        agent_id: opts?.agentId,
        session_id: opts?.sessionId,
      },
      opts?.timeoutMs,
      opts?.signal,
    );
  }

  /** Fetch 1 plugin's manifest by id (name, description, input/output schema, ...) - read-only,
   *  scoped to the caller's own tenant automatically (host resolves it from the cap token, no
   *  tenant field to pass here). `null` if the id doesn't exist or isn't visible to this tenant. */
  async pluginInfo(pluginId: string): Promise<PluginManifest | null> {
    return this.call<PluginManifest | null>('plugin.info', { plugin_id: pluginId });
  }

  /** Semantic search over the plugin store (this tenant's installed plugins + the public global
   *  store) for plugins matching `query` - useful for discovering what's available before calling
   *  `triggerPlugin()`. Ranked by relevance; `opts.threshold` (0-1) filters out weak matches. */
  async pluginSearch(query: string, opts?: { limit?: number; threshold?: number }): Promise<PluginManifest[]> {
    return this.call<PluginManifest[]>('plugin.search', { query, limit: opts?.limit, threshold: opts?.threshold });
  }

  /** Picks the single BEST-fitting plugin for a described task (`query`), or `null` if nothing
   *  clears the confidence bar - same selection logic the platform's own agent uses to decide
   *  whether a user request should route to a plugin at all. Prefer this over `pluginSearch()`
   *  when you want one clear answer ("does a plugin fit this?") rather than a ranked list to
   *  choose from yourself. `opts.allowedPluginIds` restricts candidates to a given allowlist. */
  async pluginFit(query: string, opts?: { allowedPluginIds?: string[] }): Promise<PluginManifest | null> {
    return this.call<PluginManifest | null>('plugin.fit', { query, allowed_plugin_ids: opts?.allowedPluginIds });
  }

  /** Fetch several plugins' manifests at once by id - saves N round trips vs calling `pluginInfo()`
   *  in a loop. Mirrors `workspace.getByIds` vs `workspace.get`. Ids that don't exist or aren't
   *  visible to this tenant are simply omitted from the result (not `null` placeholders). */
  async pluginInfoBatch(pluginIds: string[]): Promise<PluginManifest[]> {
    return this.call<PluginManifest[]>('plugin.infoBatch', { plugin_ids: pluginIds });
  }

  /** Checks whether a plugin's circuit breaker currently allows execution, without actually
   *  triggering it - useful to check before `triggerPlugin()` if you want to fail fast/fall back
   *  instead of waiting on a plugin already known to be failing repeatedly. `state` is `'closed'`
   *  (healthy, executes normally) or `'open'` (recent failures tripped the breaker; `allowed` will
   *  be `false` until it resets). */
  async pluginStatus(pluginId: string): Promise<{ allowed: boolean; state: 'closed' | 'open' }> {
    return this.call('plugin.status', { plugin_id: pluginId });
  }

  /**
   * Shared by `agent.runFlow`/`promptAgentic`/`promptAction`/`promptAssistant`/`prompt`: calls
   * `namespace` as a plain unary request (`call()`) when no `onEvent` callback is given - identical
   * cost/behavior to before this existed - or, when `onEvent` IS given, opens the same gRPC
   * server-streaming RPC `ai.promptStream` uses (`invokeStream`), forwarding each incremental chunk
   * (a JSON-encoded log event from the backend's `clientLog(...)` calls made while the request is
   * still running) to `onEvent` as it arrives, and resolving to the same final value `call()` would
   * have returned. A chunk that fails to parse as JSON is silently dropped rather than thrown -
   * matches this SDK's general policy of never letting an observability side-channel break the
   * actual call.
   *
   * `timeoutMs` defaults to `LONG_RUNNING_DEFAULT_TIMEOUT_MS` (5 min), not `this.defaultTimeoutMs`
   * (30s) - all 5 callers of this can run a full agentic plan or a multi-stage flow (LOOP/WAIT
   * stages included), which routinely takes far longer than a typical SDK call. Still fully
   * overridable per call via `opts.timeoutMs` for flows expected to run even longer.
   */
  private callWithOptionalEvents<T = any>(
    namespace: string,
    params: any,
    onEvent?: (event: ClientLogEvent) => void,
    timeoutMs?: number,
  ): Promise<T> {
    const effectiveTimeoutMs = timeoutMs ?? LONG_RUNNING_DEFAULT_TIMEOUT_MS;
    if (!onEvent) return this.call<T>(namespace, params, effectiveTimeoutMs);
    const handle = this.invokeStream<T>({
      namespace,
      params,
      context: this.buildContext(),
      timeoutMs: effectiveTimeoutMs,
    });
    (async () => {
      for await (const raw of handle.chunks) {
        try {
          onEvent(JSON.parse(raw) as ClientLogEvent);
        } catch {
          // Malformed/non-JSON chunk - drop it, never let this side-channel break the real call.
        }
      }
    })().catch(() => {});
    return handle.final;
  }

  close(): void {
    // No persistent connection to tear down per-call; kept for backend contract parity.
  }

  // ── Shorthand helpers ─────────────────────────────────────────────────

  ask(question: string, schema?: Record<string, any>): Promise<string | null> {
    return this.call('agent.ask', { question, schema });
  }

  hil(
    key: string,
    prompt: string,
    options?: {
      selections?: Array<{ label: string; value: string; description?: string }>;
      allow_custom_input?: boolean;
      custom_input_placeholder?: string;
      timeout_ms?: number;
    },
  ): Promise<{ value: string; label?: string; is_custom: boolean }> {
    return this.call('agent.hil', { key, prompt, ...options });
  }

  /**
   * Mirrors the backend's own `a2a()`: if `target` doesn't look like an agent ID
   * (contains a space, is long, or has non-hex characters), it's treated as a search query and
   * resolved via `workspace.searchAgents` first.
   */
  async a2a<T = unknown>(
    target: string,
    data: Record<string, unknown>,
    purpose: string,
  ): Promise<T> {
    let agentId = target;

    if (target && !looksLikeAgentId(target)) {
      const results = await this.call<any[]>('workspace.searchAgents', {
        query: target,
        workspace_id: this.context.workspace?.id || this.context.session?.workspace_id,
        limit: 1,
      });
      if (!results || results.length === 0) {
        throw new Error(`No agent found matching: ${target}`);
      }
      agentId = results[0].id;
    }

    return this.call('agent.delegate', { agentId, data, purpose });
  }

  get config(): Record<string, any> {
    return this.context.config ?? {};
  }

  log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const method = level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log';
    const ts = logTimestamp();
    if (logColorEligible()) {
      const color = LOG_LEVEL_COLOR[level];
      console[method](`${ANSI_DIM}${ts}${ANSI_RESET} ${color}[plugin:${level}]${ANSI_RESET} ${msg}`);
    } else {
      console[method](`${ts} [plugin:${level}] ${msg}`);
    }
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  saveConnection(
    connectionId: string,
    data: { provider: string; name: string; credentials: any },
  ): Promise<void> {
    return this.call('workspace.saveConnection', { id: connectionId, ...data });
  }

  user(id: string): Promise<User> {
    return this.call('user.getUser', { user_id: id });
  }

  /** Redis-cached variant of `user()` - use for high-traffic channels (e.g. widget connect/send). */
  getCachedUser(id: string): Promise<User> {
    return this.call('user.getCachedUser', { user_id: id });
  }

  // Streaming drivers are only meaningful inside the host process (LITE/WASM/in-process runtimes);
  // Docker-runtime plugins observe progress via `realtime.publish` instead. Kept for backend
  // contract shape parity but intentionally unimplemented here - throws so callers fail loudly, not silently.
  readonly stream = {
    message: (): never => {
      throw new Error(
        'sdk.stream.message() is not available for Docker-runtime plugins. Use sdk.call("realtime.publish", ...) instead.',
      );
    },
    comment: (_taskId: string): never => {
      throw new Error(
        'sdk.stream.comment() is not available for Docker-runtime plugins. Use sdk.call("realtime.publish", ...) instead.',
      );
    },
    task: (_taskId: string, _field?: string): never => {
      throw new Error(
        'sdk.stream.task() is not available for Docker-runtime plugins. Use sdk.call("realtime.publish", ...) instead.',
      );
    },
  };

  // ── Namespace sugar objects (mirrors the backend's own plugin contract) ─

  /**
   * Param shapes verified against the backend's real implementation, not just its declared type
   * contract (which diverges from the actual implementation in several places - e.g. it
   * declares `getEmbeddings({texts, opts})` and `rerank({query, docs, ...opts})`, but the real
   * code takes `getEmbeddings(texts, opts)` and nests rerank's options under `opts`).
   * `tts`/`stt`/`getModels`/`calculateTokens` confirmed against the backend's own registration calls.
   */
  readonly ai = {
    /**
     * Same call, same interface as the backend's own prompt function - what
     * the 3rd param IS decides the mode, no separate streaming method to remember:
     * - **Omitted** - plain unary call (unchanged from before this existed): waits for the whole
     *   response, resolves once. Zero added cost - never opens the streaming RPC.
     *   ```ts
     *   const full = await ctx.sdk.ai.prompt("write a haiku");
     *   ```
     * - **A `Writable`** (anything with `.write()`/`.end()` - a Node stream, an HTTP response, a
     *   `PassThrough` you pipe elsewhere yourself) - text deltas are written into it as they're
     *   generated, `.end()` when the response completes, `.destroy(err)` on failure. Lets you hand
     *   the model's output straight to whatever already consumes a stream, no manual bridging:
     *   ```ts
     *   await ctx.sdk.ai.prompt("write a haiku", undefined, res); // res: an HTTP ServerResponse
     *   ```
     * - **A `MessageListener`** - `onUpdate`/`onParsedLine`/`onCompleted`/`onError` (and more) fire
     *   as data arrives - see `MessageListener`'s doc comment for exactly which callbacks are wired:
     *   ```ts
     *   await ctx.sdk.ai.prompt(quest, { lineSchema: "[from:string-id] -> [to:string-id]" }, {
     *     onParsedLine: (line) => console.log(line?.fields.from, "->", line?.fields.to),
     *   });
     *   ```
     * All 3 forms resolve to the same final aggregated value either way - callers that only want
     * the finished result never need to touch the 3rd param at all. Falls back to a single "chunk"
     * (the whole response, then done) if the model/provider resolved server-side doesn't support
     * token-level streaming - behaves the same either way, just with coarser granularity.
     */
    prompt: (quest: string | any[], opts?: LLMPromptOptions, driver?: MessageListener | NodeJS.WritableStream): Promise<any> => {
      // `signal` is a local transport-level knob (cancels the gRPC call itself), not wire data -
      // stripped out of what actually gets sent as `opts` in both branches below (see
      // `LLMPromptOptions.signal`'s doc comment for why sending it would be meaningless anyway).
      // `request_id` DOES need to reach the host, just under its real field name - see
      // `LLMPromptOptions.request_id`'s doc comment for why the public name differs from the wire one.
      const { signal, request_id, ...restOpts } = opts ?? {};
      const wireOpts = request_id ? { ...restOpts, unique_request_id: request_id } : restOpts;
      if (!driver) return this.call('ai.prompt', { quest, opts: wireOpts }, undefined, signal);

      // A caller's own listener callback throwing (a bug in THEIR code, not a transport failure)
      // must not silently truncate the rest of the stream for them - wrap each invocation so one
      // bad chunk/line doesn't stop delivery of every chunk/line after it, and surface it somewhere
      // visible instead of vanishing into an unawaited rejection.
      // `await`ed by every call site below (not fire-and-forget) - a callback MAY return a Promise
      // (declared `void` in `MessageListener` for caller convenience, same TS leniency the backend's
      // own `MessageListener` callbacks rely on - see BaseDTO.ts) specifically so real backpressure
      // (the Writable adapter's `'drain'` wait below, or a caller's own slow async `onUpdate`) can
      // pause this stream's drain loop for real, not just visually "await" something already settled.
      const safeInvoke = async <A extends any[]>(fn: ((...args: A) => void | Promise<void>) | undefined, ...args: A): Promise<void> => {
        if (!fn) return;
        try {
          await fn(...args);
        } catch (err) {
          console.error('[@aivin-labs/sdk] ai.prompt() listener callback threw:', err);
        }
      };

      // A `Writable`-shaped 3rd arg (duck-typed on `.write`/`.end` - covers Node's `Writable`,
      // `Duplex`/`PassThrough`, and an HTTP `ServerResponse` alike) gets adapted into a plain
      // `MessageListener` right here, so everything below this point only ever deals with one
      // shape. `.write()`'s return value IS consulted for real backpressure, same contract
      // `readable.pipe(writable)` itself honors: `false` means the writable's internal buffer is
      // full, so `onUpdate` returns a Promise that only resolves on `'drain'` - `safeInvoke` above
      // awaits it, pausing `drainChunks` below until the writable can actually accept more. Without
      // this, a downstream consumer slower than the model (a slow disk write, a throttled HTTP
      // response) would have its OWN internal buffer grow unbounded, exactly the failure mode a real
      // `.pipe()` call prevents.
      const isWritable = typeof (driver as any).write === 'function' && typeof (driver as any).end === 'function';
      const listener: MessageListener = isWritable
        ? {
            onUpdate: (chunk: string) => {
              const writable = driver as NodeJS.WritableStream;
              if (writable.write(chunk)) return;
              return new Promise<void>((resolve) => writable.once('drain', resolve));
            },
            onCompleted: () => { (driver as NodeJS.WritableStream).end(); },
            onError: (err: any) => {
              const stream = driver as NodeJS.WritableStream & { destroy?: (error?: Error) => void };
              stream.destroy?.(err instanceof Error ? err : new Error(String(err)));
            },
          }
        : (driver as MessageListener);

      const handle = this.invokeStream<any>({
        namespace: 'ai.promptStream',
        // `wantsRawLine`/`wantsReasoning` are wire-negotiation flags, NOT part of `opts` (kept out
        // of `LLMPromptOptions` on purpose - they're an implementation detail of this method, not
        // something a caller would ever set directly). The host only attaches `onLine`/
        // `onReasoning` to its listener when asked - otherwise every `ai.prompt()` call
        // with ANY listener would pay for host-side line-buffering/reasoning-forwarding whether or
        // not the caller's own listener even declares those callbacks. `onParsedLine` doesn't need
        // an equivalent flag - `opts.lineSchema` already gates it unambiguously.
        params: { quest, opts: wireOpts, wantsRawLine: !!listener.onLine, wantsReasoning: !!listener.onReasoning },
        context: this.buildContext(),
        timeoutMs: this.defaultTimeoutMs,
        signal,
      });

      // `chunks`/`lines`/`rawLines`/`reasoning` are four independent generators over the SAME
      // underlying stream (see `StreamHandle`'s doc comments in `GrpcInvoker.ts`) - drained
      // concurrently so no one callback is gated behind fully exhausting another. A REAL transport
      // error breaks all four loops together (same underlying `streamError`).
      const drainChunks = (async () => {
        for await (const delta of handle.chunks) await safeInvoke(listener.onUpdate, delta, 'text');
      })();
      const drainLines = (async () => {
        let index = 0;
        for await (const parsed of handle.lines) await safeInvoke(listener.onParsedLine, parsed, index++);
      })();
      const drainRawLines = (async () => {
        for await (const line of handle.rawLines) await safeInvoke(listener.onLine, line);
      })();
      const drainReasoning = (async () => {
        for await (const text of handle.reasoning) await safeInvoke(listener.onReasoning, text);
      })();

      // `handle.final` resolving does NOT by itself mean every buffered chunk/line/reasoning value
      // has already been popped off its queue and handed to the caller's listener - `final` and the
      // 4 drain loops above are independent async chains unblocked by the same underlying stream
      // ending, not causally ordered against each other. Without this, `onCompleted`/the returned
      // Promise could resolve while a trailing `onUpdate`/`onParsedLine` call for already-buffered
      // data is still pending, dispatched to the caller *after* they thought the call was done.
      // Each `.catch(() => {})` here is safe - a drain loop only ever throws the SAME `streamError`
      // `handle.final` itself rejects with (see `StreamHandle`'s doc comments), so `handle.final`
      // below remains the one authoritative source for success/failure and the `err` passed to
      // `onError`.
      const drained = Promise.all([
        drainChunks.catch(() => {}),
        drainLines.catch(() => {}),
        drainRawLines.catch(() => {}),
        drainReasoning.catch(() => {}),
      ]);

      return drained.then(() => handle.final).then(
        async (result) => { await safeInvoke(listener.onCompleted); return result; },
        async (err) => { await safeInvoke(listener.onError, err); throw err; },
      );
    },
    /**
     * Pull-based counterpart of `prompt()` - same streaming transport, `AsyncIterable`s instead of
     * a `Writable`/`MessageListener` 3rd arg. Reach for this over `prompt(quest, opts, aWritable)`
     * when you want to `for await` the result yourself, or compose it with other iterable-based
     * tooling (`Readable.from(result.textStream)`, async generator pipelines, etc.) rather than
     * push into an existing stream object:
     * ```ts
     * const result = ai.promptStream("write a haiku");
     * for await (const delta of result.textStream) process.stdout.write(delta);
     * const full = await result.text; // full text, resolves once the stream ends
     * ```
     */
    promptStream: (quest: string | any[], opts?: LLMPromptOptions): { textStream: AsyncIterable<string>; text: Promise<string>; lines: AsyncIterable<ParsedLine> } => {
      const { signal, request_id, ...restOpts } = opts ?? {};
      const wireOpts = request_id ? { ...restOpts, unique_request_id: request_id } : restOpts;
      const handle = this.invokeStream<string>({
        namespace: 'ai.promptStream',
        params: { quest, opts: wireOpts },
        context: this.buildContext(),
        timeoutMs: this.defaultTimeoutMs,
        signal,
      });
      return { textStream: handle.chunks, text: handle.final, lines: handle.lines };
    },
    /**
     * Cancels an in-flight `ai.prompt()`/`ai.promptStream()` call started with the same
     * `opts.request_id` - from anywhere, not just the invocation that started it (a different
     * request/plugin instance entirely - see `LLMPromptOptions.request_id`'s doc comment). Under the
     * hood this is a pubsub broadcast to every backend node, not a polled flag -
     * whichever node is actually running that request aborts it immediately. Resolves once the
     * cancel request itself completes - not a guarantee the target call has fully unwound yet (it
     * rejects with an aborted error on its own end shortly after).
     */
    cancel: (requestId: string): Promise<{ cancelled_locally: boolean }> =>
      this.call('ai.cancel', { unique_request_id: requestId }),
    getEmbedding: (
      text: string | string[],
      opts?: LLMPromptOptions,
    ): Promise<Float32Array | Float32Array[]> => this.call('ai.getEmbedding', { text, opts }),
    getEmbeddings: (texts: string[], opts?: LLMPromptOptions): Promise<Float32Array[]> =>
      this.call('ai.getEmbeddings', { texts, opts }),
    rerank: (
      query: string,
      docs: string[],
      opts?: any,
    ): Promise<{ index: number; score: number }[]> => this.call('ai.rerank', { query, docs, opts }),
    tts: (text: string, opts?: Record<string, any>): Promise<any> =>
      this.call('ai.tts', { text, opts }),
    stt: (audio: any, opts?: Record<string, any>): Promise<any> =>
      this.call('ai.stt', { audio, opts }),
    getModels: (provider?: string): Promise<any> => this.call('ai.getModels', { provider }),
    calculateTokens: (data: Record<string, any>): Promise<any> =>
      this.call('ai.calculateTokens', { data }),
    /** Extract text from an image via OCR. `image` needs either a real `url` or `file` (base64
     *  dataURL/Buffer) - `id` is caller-chosen, not looked up server-side. */
    ocr: (image: MediaItem): Promise<string> => this.call('ai.ocr', { image }),
    /** Generate an image from a text prompt. Set `opts.max_cost_usd` to cap spend - over-estimate
     *  auto-downgrades to a cheaper tier (or throws if none fits) instead of silently costing more. */
    image: (prompt: string, opts?: MediaPromptOptions): Promise<MediaGenerationResult> =>
      this.call('ai.image', { prompt, opts }),
    /** Generate a video from a text prompt - same cost-guard/tier options as `image()`. Slower and
     *  more expensive than image generation; always set `opts.max_cost_usd` unless cost is a
     *  non-concern for this call site. */
    video: (prompt: string, opts?: MediaPromptOptions): Promise<MediaGenerationResult> =>
      this.call('ai.video', { prompt, opts }),
  };

  /**
   * `search`/`reinforce` confirmed against the backend's real registration handlers.
   * `get`/`del` now confirmed real too (`knowledge.batchGetKnowledge`/
   * `knowledge.batchDeleteKnowledge` handlers) - previously undocumented here, reachable only via
   * the untyped `call()` escape hatch.
   */
  readonly knowledge = {
    search: (
      query: string,
      opts?: { workspace_id?: string; limit?: number; threshold?: number },
    ): Promise<any[]> => this.call('knowledge.searchKnowledge', { query, ...opts }),
    store: (knowledge: any, scope?: Record<string, any>): Promise<any> =>
      this.call('knowledge.storeKnowledge', { knowledge, scope }),
    reinforce: (ids: string[]): Promise<any> => this.call('knowledge.reinforceKnowledge', { ids }),
    get: (knowledgeIds: string[]): Promise<any[]> =>
      this.call('knowledge.batchGetKnowledge', { knowledgeIds }),
    del: (ids: string[]): Promise<any> => this.call('knowledge.batchDeleteKnowledge', { ids }),
  };

  /**
   * `plugin.*` — catalog read/write for the plugin marketplace (named `plugin`, not
   * `pluginStore`, purely for a shorter call site — this is NOT the same thing as a plugin's own
   * runtime `ctx`/ordinary SDK calls, don't confuse the two). Gated server-side to a privileged
   * internal caller identity — a regular plugin calling this gets rejected by the server, so it has
   * no business appearing in a plugin author's Monaco autocomplete. `@internal` (stripped from the
   * published `.d.ts` — still callable at runtime by the internal service that compiles against
   * this same source, just invisible to `.d.ts` consumers).
   * Only `findDocsBySourceRepo`/`patchByIds` are given typed sugar here (the two actually consumed
   * in production) — the namespace has ~14 more registrations (`getPlugin`, `searchPlugins`,
   * `upsertPlugins`, ...) still only reachable through the untyped `call()` escape hatch; add sugar
   * here if/when something else starts reaching for them, rather than speculatively wrapping all of
   * them.
   *
   * @internal
   */
  readonly plugin = {
    findDocsBySourceRepo: (repo: string): Promise<any[]> =>
      this.call('plugin.findDocsBySourceRepo', { repo }),
    patchByIds: (ids: any[], fields: Record<string, any>): Promise<void> =>
      this.call('plugin.patchByIds', { ids, fields }),
  };

  /**
   * `search`/`index` confirmed against the backend's real registration handlers.
   * `searchBatch`/`get`/`delete`/`matchBatch` are newer additions to that same registrar - server
   * always re-derives `workspace_id` from ctx for `get`/`delete` (plugin-supplied ids are filtered
   * down to what actually belongs to the caller's workspace before returning/deleting).
   * `similarity`/`normalize` are PURE LOCAL MATH (no `call()`, no network round-trip) - safe to use
   * on embeddings you already hold (e.g. from `ai.getEmbedding`) without hitting the server.
   *
   * All read/write methods take an optional `collection` (a label, not a raw internal name) to
   * target a DEDICATED collection instead of the shared default one - see `requestCollection`/
   * `getCollectionStatus`. The label only resolves once its request has been admin-approved;
   * passing an unrecognized/still-pending label throws rather than silently falling back to the
   * shared collection - self-serve collection *creation* is deliberately not exposed here
   * (provisioning a new physical collection is resource-affecting, so it goes through human
   * approval). The same is true in reverse: there is no plugin-facing "delete my collection" - an
   * admin archives (physically drops) it once a request is approved; after that, the label stops
   * resolving and further calls with it throw.
   */
  readonly vector = {
    search: (params: {
      query: string;
      type?: string;
      limit?: number;
      threshold?: number;
      collection?: string;
      /** Re-score results with `ai.rerank` (LLM-based, more accurate than raw cosine similarity)
       *  before returning - costs one extra AI call. */
      rerank?: boolean;
    }): Promise<any[]> => this.call('vector.searchDocuments', params),
    index: (params: {
      content: string;
      type?: string;
      id?: string;
      metadata?: Record<string, unknown>;
      collection?: string;
    }): Promise<void> => this.call('vector.indexDocument', params),
    searchBatch: (params: {
      queries: string[];
      type?: string;
      limit?: number;
      threshold?: number;
      collection?: string;
      /** Applied per-query - see `search()`'s `rerank`. Costs one extra AI call per query. */
      rerank?: boolean;
    }): Promise<any[][]> => this.call('vector.searchBatch', params),
    get: (ids: string[], collection?: string): Promise<any[]> =>
      this.call('vector.getDocuments', { ids, collection }),
    delete: (ids: string[], collection?: string): Promise<{ deleted: number }> =>
      this.call('vector.deleteDocuments', { ids, collection }),
    matchBatch: (
      texts: string[],
      query: string,
      threshold?: number,
    ): Promise<{ text: string; isMatch: boolean; score: number }[]> =>
      this.call('vector.matchBatch', { texts, query, threshold }),
    similarity: (a: Float32Array, b: Float32Array): number => {
      if (!a || !b || a.length !== b.length) return 0;
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      if (na === 0 || nb === 0) return 0;
      return dot / Math.sqrt(na * nb);
    },
    normalize: (v: Float32Array): Float32Array => {
      if (!v || v.length === 0) return v;
      let normSq = 0;
      for (let i = 0; i < v.length; i++) normSq += v[i] * v[i];
      if (normSq === 0) return v;
      const invNorm = 1 / Math.sqrt(normSq);
      const out = new Float32Array(v.length);
      for (let i = 0; i < v.length; i++) out[i] = v[i] * invNorm;
      return out;
    },
    /**
     * Requests a dedicated collection (physically isolated from the shared default one).
     * Only creates a 'pending' request - does NOT provision anything yet; an admin must approve it
     * out-of-band before `collection: label` resolves anywhere else in this namespace. Idempotent:
     * calling again with the same `label` while pending/approved returns the existing request
     * instead of duplicating. `dimension`, if given, must equal the platform's current default
     * embedding dimension - custom collections get physical isolation, not a different vector
     * dimension.
     */
    requestCollection: (params: {
      label: string;
      reason?: string;
      dimension?: number;
    }): Promise<{
      id: string;
      label: string;
      collection_name: string;
      status: 'pending' | 'approved' | 'rejected';
      dimension: number;
    }> => this.call('vector.requestCollection', params),
    /** Checks the status of a collection request made via `requestCollection()`. */
    getCollectionStatus: (
      label: string,
    ): Promise<{
      status: 'pending' | 'approved' | 'rejected' | 'not_requested';
      label: string;
      collection_name?: string;
    }> => this.call('vector.getCollectionStatus', { label }),
  };

  readonly datasource = {
    getSources: (params?: { scope?: any }): Promise<any[]> =>
      this.call('datasource.getTrainingSourceList', params),
    getDomains: (params?: { scope?: any }): Promise<any[]> =>
      this.call('datasource.getKnowledgeDomains', params),
    learn: (params: { source_id: string }): Promise<any> =>
      this.call('datasource.learnFrom', params),
  };

  /**
   * Matches the backend's own `get causality()` exactly (`think`/`absorb`, params
   * spread directly into the call, not nested under `mission`/`context`). There is no separate
   * `think` namespace with `deep`/`search` on the real SDK - that was invented from the declared-but-
   * unimplemented `think.*` overloads in the backend's type contract.
   */
  readonly causality = {
    think: (query: string, opts?: Record<string, any>): Promise<any> =>
      this.call('think.deep', { query, ...opts }),
    absorb: (causalities: any[], opts?: Record<string, any>): Promise<any> =>
      this.call('think.absorb', { causalities, ...opts }),
    search: (
      query: string,
      opts?: { limit?: number; threshold?: number },
    ): Promise<any[]> => this.call('think.search', { query, ...opts }),
  };

  readonly attachment = {
    search: (params: { query: string; limit?: number }): Promise<any[]> =>
      this.call('attachment.search', params),
    upload: (params: {
      file: { url: string; name: string; mimeType: string; size: number };
    }): Promise<{ url: string; docId: string }> => this.call('attachment.upload', params),
    deepResearch: (params: {
      mission: string;
      docIds?: string[];
      maxRounds?: number;
    }): Promise<{
      answer: string;
      citations: { doc_id: string; filename?: string }[];
      rounds: number;
    }> => this.call('attachment.deepResearch', params),
    evaluate: (params: {
      criteria: string;
      docIds?: string[];
    }): Promise<{
      summary: string;
      findings: { aspect: string; assessment: string; severity?: string }[];
      doc_ids_used: string[];
    }> => this.call('attachment.evaluate', params),
    queryTabularData: (params: {
      docId: string;
      question: string;
    }): Promise<{ answer: string; tables_used: number }> =>
      this.call('attachment.queryTabularData', params),
    queryMediaTimestamp: (params: {
      docId: string;
      question: string;
    }): Promise<{ answer: string }> => this.call('attachment.queryMediaTimestamp', params),
    extract: (params: {
      docId: string;
    }): Promise<{
      fileName: string;
      chunks: { content: string; chunk_index?: number; source?: string }[];
    }> => this.call('attachment.extract', params),
  };

  readonly workspace = {
    get: (id: string): Promise<Workspace> => this.call('workspace.getWorkspace', { id }),
    getByIds: (ids: string[]): Promise<Workspace[]> =>
      this.call('workspace.getWorkspacesByIds', { ids }),
    getMembers: (): Promise<string[]> => this.call('workspace.getMembers', {}),
    checkPermission: (params: {
      workspace_id?: string;
      user_id?: string;
      permission: string;
    }): Promise<boolean> => this.call('workspace.checkMemberPermission', params),
    getPluginConfig: (params: { plugin_id: string; workspace_id?: string }): Promise<any> =>
      this.call('workspace.getPluginConfig', params),
    updatePlugin: (params: {
      plugin_id: string;
      workspace_id?: string;
      arguments: Record<string, any>;
    }): Promise<any> => this.call('workspace.updateWorkspacePlugin', params),
    searchAgents: (params: {
      query: string;
      limit?: number;
      threshold?: number;
    }): Promise<Agent[]> => this.call('workspace.searchAgents', params),
  };

  /**
   * `ask`/`hil` are NOT on the backend's real `get agent()` - only standalone
   * `sdk.ask()`/`sdk.hil()` exist. Removed here to avoid implying a namespaced variant that isn't
   * real; use the top-level methods instead. `delegate` reuses `a2a()`'s search-resolution logic
   * for consistency (the real `get agent()` doesn't define `delegate` itself either - only the
   * standalone `a2a()` does - but the underlying `agent.delegate` namespace is confirmed real).
   */
  readonly agent = {
    get: (id?: string): Promise<Agent> => this.call('agent.getAIStaff', { id }),
    status: (id?: string): Promise<any> => this.call('agent.getStatus', { agent_id: id }),
    cancel: (sessionId: string, threadId?: string): Promise<any> =>
      this.call('agent.cancelResponse', { session_id: sessionId, thread_id: threadId }),
    delegate: (target: string, data: Record<string, unknown>, purpose: string): Promise<any> =>
      this.a2a(target, data, purpose),
    /**
     * Prompt the LLM and stream the result straight into the current chat bubble - same signature
     * as `ai.prompt`, but resolves to a real, persisted chat message (buffered/flushed and saved by
     * the host's message pipeline) instead of a bare string. Falls back to a plain, non-streamed
     * `ai.prompt` call when this invocation has no live chat session (automation/webhook/API
     * context) - always safe to call regardless of channel, no need to branch on `ctx` yourself.
     *
     * Deliberately lives on `agent`, not `ai`: `ai.prompt`/`ai.promptStream` are pure LLM calls with
     * no notion of chat; this one is tied to the agent/session lifecycle (creates a real message,
     * persists it, respects the same buffering the platform's own agent replies use).
     *
     * `opts.rich_content: true` lets the model render passive components (table/chart/mermaid/
     * media/cardview/webview) correctly - plain `instructions` text does NOT teach it that syntax.
     * It will NOT render working selection/form/action components - those need `agent.hil()`'s
     * suspend+routing plumbing to actually receive a click/response back. Never use `agent.reply`
     * (or `agent.tell`) to build anything the user needs to respond to; use `agent.hil()`/`ask()`.
     */
    reply: (quest: string | any[], opts?: AgentReplyOptions): Promise<any> =>
      this.call('agent.reply', { quest, opts }),
    /**
     * Push a string you already have straight into the chat bubble, animated with a word-by-word
     * typing effect, and persisted like any other message - no LLM call involved at all. Use this
     * when the text didn't come from `ai.prompt`/`agent.reply` (composed locally, fetched from
     * elsewhere, the output of your own external call) but should still appear as a real chat turn.
     * Resolves to `{ success: false }` (not an error) when there's no live chat session to stream
     * into, same graceful-degrade philosophy as `agent.reply` and `realtime.publish`.
     *
     * This is raw text passthrough - it does NOT know about rich components at all (no
     * `rich_content` option, unlike `agent.reply`). Do not hand-write rich-component markup into
     * `text` expecting it to work, especially selection/form/action: those need `agent.hil()`'s
     * suspend+routing plumbing underneath to receive a response, which `tell` never sets up. A
     * hand-rolled button here would render but silently do nothing when clicked.
     */
    tell: (text: string): Promise<{ success: boolean }> => this.call('agent.tell', { text }),
    /** Run a full message-processing pass through the agent (NLU -> agentic/action/assistant routing). */
    processMessage: (
      message: Record<string, any>,
      storageContext?: Record<string, any>,
    ): Promise<any> => this.call('agent.processMessage', { message, storageContext }),
    /** Resolve a PAUSED human-in-the-loop checkpoint (e.g. a visitor's selection/form reply) to resume a workflow. */
    resolveHil: (params: {
      session_id: string;
      reply_id: string;
      payload?: any;
    }): Promise<{ success: boolean; reply_id: string; error?: string }> =>
      this.call('agent.resolveHil', params),
    /**
     * Runs a flow directly - CONDITION/ROUTER/PARALLEL/RETRY/WAIT/LOOP/ACTION steps executed in
     * order, no NLU/LLM planning step first (unlike `agent.processMessage`, which routes a message
     * through agentic/action/assistant). Same engine `automation.createJob`'s `workflow` field and
     * a published `workflow`-type plugin run on - this is that engine called directly from code,
     * skipping the "save as a plugin"/"schedule as a job" step.
     *
     * `flow` accepts either:
     *  - a `WorkflowGraph` (`{ nodes, edges }`) - the exact JSON the platform's Workflow Editor
     *    (WorkflowSkillEditor) exports/saves - so a flow built visually can be pasted straight in, or
     *  - a `FlowStage[]` already built by hand for full control over control-flow stages.
     *
     * `context` (build with `ContextBuilder`) is the flow's explicit identity - which agent it runs
     * as, which workspace, and optionally an existing `session_id` to run inside (instead of a new,
     * invisible session/thread). Nothing here is inferred from the caller's own live session state
     * beyond a bare agent/workspace fallback - the sandbox boundary this call crosses does not carry
     * the caller's live runtime data across automatically, so anything the flow needs must be passed
     * explicitly via `context` or baked into the flow's own nodes.
     *
     * `opts.onEvent`, if given, receives every progress log line (step started, condition evaluated,
     * stage failed, ...) live as the flow runs, instead of only the final `FlowStepResult[]` once
     * everything finishes - see [Realtime progress](../../docs/sdk/agent.md#realtime-progress-onevent)
     * for the call-shape/cost tradeoff (opens a streaming connection instead of a plain unary call).
     *
     * `opts.timeoutMs` defaults to 5 minutes (not the general 30s default) - a flow with LOOP/WAIT
     * stages can legitimately run far longer; raise this further for flows expected to take longer
     * still.
     */
    runFlow: (
      flow: WorkflowGraph | FlowStage[],
      opts?: { flowName?: string; context?: RunFlowContext; onEvent?: (event: ClientLogEvent) => void; timeoutMs?: number },
    ): Promise<FlowStepResult[]> => {
      const params = validateParams(
        runFlowParamsSchema,
        { flow, flowName: opts?.flowName, context: opts?.context },
        'agent.runFlow',
      );
      return this.callWithOptionalEvents('agent.runFlow', params, opts?.onEvent, opts?.timeoutMs);
    },
    /**
     * Forces the full agentic planner (multi-step plan/audit/replan) for
     * `prompt`, skipping the NLU classification step `agent.processMessage` would normally run
     * first. Use when the caller already knows this needs multi-step planning (e.g. a workflow node
     * that always wants "plan and execute this," not a re-guess every run). Still falls back to
     * `promptAssistant` internally on failure (that fallback is baked into the backend method
     * itself, not something forcing the mode turns off) - only the initial mode CHOICE is forced,
     * not the error-recovery path. `opts.onEvent`/`opts.timeoutMs` - see `runFlow`'s doc above.
     */
    promptAgentic: (
      prompt: string,
      opts?: { args?: Record<string, any>; context?: RunFlowContext; onEvent?: (event: ClientLogEvent) => void; timeoutMs?: number },
    ): Promise<any> =>
      this.callWithOptionalEvents('agent.promptAgentic', { prompt, args: opts?.args, context: opts?.context }, opts?.onEvent, opts?.timeoutMs),
    /**
     * Forces the single-plugin direct-execution mode (`promptAction` - select one plugin, run it, no
     * multi-step planning), skipping NLU classification. Falls back to `promptAssistant` internally
     * if no plugin matches, or to `promptAgentic` if the selected plugin's execution fails - same
     * caveat as `promptAgentic` above: only the initial mode choice is forced. `opts.onEvent`/
     * `opts.timeoutMs` - see `runFlow`'s doc above.
     */
    promptAction: (
      prompt: string,
      opts?: { context?: RunFlowContext; onEvent?: (event: ClientLogEvent) => void; timeoutMs?: number },
    ): Promise<any> =>
      this.callWithOptionalEvents('agent.promptAction', { prompt, context: opts?.context }, opts?.onEvent, opts?.timeoutMs),
    /**
     * Forces plain conversational (RAG-backed, no tool use, no planning) mode, skipping NLU
     * classification. Use when the caller already knows this turn is a question/answer, not an
     * action request. `opts.onEvent`/`opts.timeoutMs` - see `runFlow`'s doc above.
     */
    promptAssistant: (
      prompt: string,
      opts?: { context?: RunFlowContext; onEvent?: (event: ClientLogEvent) => void; timeoutMs?: number },
    ): Promise<any> =>
      this.callWithOptionalEvents('agent.promptAssistant', { prompt, context: opts?.context }, opts?.onEvent, opts?.timeoutMs),
    /**
     * Auto-routes `prompt` through the exact same NLU classification `agent.processMessage` runs
     * (agentic/action/assistant) - the lightweight counterpart to `processMessage`, which requires
     * building a full message object yourself. Use this when you have a plain prompt string and want
     * the platform to decide the mode; use `promptAgentic`/`promptAction`/`promptAssistant` instead
     * when the caller already knows which mode this turn needs. `opts.onEvent`/`opts.timeoutMs` - see
     * `runFlow`'s doc above.
     */
    prompt: (
      prompt: string,
      opts?: { context?: RunFlowContext; onEvent?: (event: ClientLogEvent) => void; timeoutMs?: number },
    ): Promise<any> =>
      this.callWithOptionalEvents('agent.prompt', { prompt, context: opts?.context }, opts?.onEvent, opts?.timeoutMs),
  };

  readonly browser = {
    /**
     * Runs a full, multi-step, self-correcting AI Browser mission. Slow/heavy compared to any other
     * namespace here - an agentic loop that can take many actions before returning, not a simple
     * request/response fetch.
     *
     * The resolved result carries `data.session_id` (server's tenant client id) whether the mission
     * succeeds, fails, or is cancelled. `browser.cancel()` always targets the calling tenant's own
     * running mission - `session_id` is accepted only as a self-check (it must match the caller's own
     * tenant or the call is rejected), NOT a way to cancel another tenant's mission.
     *
     * HIL (human-in-the-loop) is NOT supported through this call: it goes straight to
     * the backend's mission-trigger path, bypassing the suspend/resume plumbing that
     * chat/agent triggers use. If the mission hits a step that needs user confirmation, the promise
     * resolves with `{ status: 'waiting', message: '...' }` instead of actually suspending - it does
     * NOT wait for a human. Route missions that may need HIL through chat/agent triggers instead.
     */
    run: (
      mission: string,
      opts?: {
        start_url?: string;
        success_criteria?: string[];
        steps?: string[];
        output_schema?: Record<string, any>;
        [key: string]: any;
      },
    ): Promise<any> => this.call('browser.run', { mission, data: opts }),

    /**
     * Requests cancellation of a running AI Browser mission. Cooperative only: the backend checks
     * for this between agentic-loop steps (each step is an LLM call plus a browser action), so it
     * cannot interrupt a step already in flight - expect roughly one step's worth of delay before the
     * mission actually stops. Always cancels the CALLING tenant's own running mission - `sessionId`
     * is optional and only checked against that tenant (mismatches are rejected); it cannot be used
     * to cancel a different tenant's mission.
     */
    cancel: (sessionId?: string): Promise<{ success: boolean; session_id: string }> =>
      this.call('browser.cancel', sessionId ? { session_id: sessionId } : {}),

    /**
     * Streaming counterpart of `run()` - identical mission/opts shape, but returns live per-step
     * progress chunks as the mission runs, instead of only the final result once everything is
     * done. Each chunk is the same step payload the chat UI's screencast panel receives over
     * `browser:agent-step` (`{ step, type, url, summary, clientId }`), JSON-stringified:
     * ```ts
     * const { steps, result } = ctx.sdk.browser.runStream('...', { start_url: '...' });
     * for await (const raw of steps) console.log(JSON.parse(raw));
     * const final = await result;
     * ```
     * Solves two things `run()` can't: (1) real visibility into what the agent is doing while it's
     * still running, useful for debugging a mission live instead of only seeing pass/fail at the
     * end; (2) missions whose total duration exceeds an intermediate proxy's response-timeout (e.g.
     * a reverse proxy/tunnel that gives up waiting after ~100s of silence) - because this is a
     * stream, each step is a real byte flowing over the connection, so it's never mistaken for a
     * stalled request and cut off, unlike a single unary call that stays silent until the whole
     * mission resolves.
     *
     * Uses a longer built-in timeout than the SDK's general default (10 minutes, matching the
     * documented AI Browser mission ceiling) since this call is specifically for long-running
     * missions - unlike `run()`, which inherits the generic default and needs the `call()` escape
     * hatch for a longer deadline (see docs/sdk/browser.md).
     *
     * Same HIL caveat as `run()`: not supported through this call either (see `run()`'s doc above).
     */
    runStream: (
      mission: string,
      opts?: {
        start_url?: string;
        success_criteria?: string[];
        steps?: string[];
        output_schema?: Record<string, any>;
        [key: string]: any;
      },
    ): { steps: AsyncGenerator<string, void, void>; result: Promise<any> } => {
      const handle = this.invokeStream<any>({
        namespace: 'browser.runStream',
        params: { mission, data: opts },
        context: this.buildContext(),
        timeoutMs: 600_000,
      });
      return { steps: handle.chunks, result: handle.final };
    },
  };

  readonly project = {
    get: (params: { id: string }): Promise<any> => this.call('project.getProject', params),
    search: (params: { workspace_id?: string; keyword?: string }): Promise<any[]> =>
      this.call('project.searchProject', params),
  };

  /**
   * `updateRow`/`deleteRow`/`smartQuery`/`batchUpdateByAI` fixed to match the backend's real,
   * simpler `get table()` signatures (no `workspace_id`/`project_id`/`ctx` -
   * those are resolved server-side from the caller's identity, not passed by the client). Added
   * `ensureTable`/`getRow`, both confirmed there but missing here before.
   *
   * Every method validates `params` against a zod schema (`validation.ts`) before the call goes
   * out - verified field-by-field against the backend's real implementation (all correct already;
   * this adds the runtime guard against future drift, not a shape fix).
   */
  readonly table = {
    ensureTable: (params: {
      purpose: string;
      workspace_id?: string;
      project_id?: string;
      target_columns?: string[];
    }): Promise<any> =>
      this.call('table.ensureTable', validateParams(ensureTableParamsSchema, params, 'table.ensureTable')),
    createTable: (params: {
      workspace_id: string;
      project_id: string;
      name: string;
      description?: string;
      columns: any[];
      primary_id?: string;
      primary_key_column?: string;
    }): Promise<any> =>
      this.call('table.createTable', validateParams(createTableParamsSchema, params, 'table.createTable')),
    getTables: (params: { workspace_id: string; project_id: string }): Promise<any[]> =>
      this.call('table.getTables', validateParams(getTablesParamsSchema, params, 'table.getTables')),
    getTable: (params: { workspace_id: string; table_id: string }): Promise<any> =>
      this.call('table.getTable', validateParams(getTableParamsSchema, params, 'table.getTable')),
    updateTable: (params: {
      workspace_id: string;
      table_id: string;
      name?: string;
      description?: string;
      columns?: any[];
      primary_id?: string;
      primary_key_column?: string;
    }): Promise<any> =>
      this.call('table.updateTable', validateParams(updateTableParamsSchema, params, 'table.updateTable')),
    deleteTable: (params: { workspace_id: string; table_id: string }): Promise<any> =>
      this.call('table.deleteTable', validateParams(deleteTableParamsSchema, params, 'table.deleteTable')),
    addRow: (params: {
      workspace_id: string;
      project_id: string;
      table_id: string;
      data: Record<string, any>;
    }): Promise<any> =>
      this.call('table.addRow', validateParams(addRowParamsSchema, params, 'table.addRow')),
    getRow: (rowId: string): Promise<any> =>
      this.call('table.getRow', { id: validateParams(z.string().min(1, 'rowId is required'), rowId, 'table.getRow') }),
    updateRow: (rowId: string, data: Record<string, any>): Promise<any> =>
      this.call('table.updateRow', {
        row_id: validateParams(z.string().min(1, 'rowId is required'), rowId, 'table.updateRow'),
        ...data,
      }),
    deleteRow: (rowId: string): Promise<any> =>
      this.call('table.deleteRow', { row_id: validateParams(z.string().min(1, 'rowId is required'), rowId, 'table.deleteRow') }),
    getRows: (params: {
      workspace_id: string;
      project_id: string;
      table_id: string;
      filter?: Record<string, any>;
      sort?: Record<string, any>;
      page?: number;
      limit?: number;
    }): Promise<any[]> =>
      this.call('table.getRows', validateParams(getRowsParamsSchema, params, 'table.getRows')),
    batchUpdateRows: (params: {
      workspace_id: string;
      project_id: string;
      table_id: string;
      filter: Record<string, any>;
      update: Record<string, any>;
    }): Promise<any> =>
      this.call('table.batchUpdateRows', validateParams(batchUpdateRowsParamsSchema, params, 'table.batchUpdateRows')),
    batchDeleteRows: (ids: string[]): Promise<any> =>
      this.call('table.batchDeleteRows', {
        ids: validateParams(batchDeleteRowsParamsSchema, ids, 'table.batchDeleteRows'),
      }),
    bulkAddRows: (params: {
      workspace_id: string;
      project_id: string;
      table_id: string;
      rows: Record<string, any>[];
    }): Promise<any> =>
      this.call('table.bulkAddRows', validateParams(bulkAddRowsParamsSchema, params, 'table.bulkAddRows')),
    smartQuery: (query: string): Promise<any> =>
      this.call('table.smartQuery', { query: validateParams(smartQueryParamSchema, query, 'table.smartQuery') }),
    batchUpdateByAI: (instruction: string): Promise<any> =>
      this.call('table.batchUpdateByAI', {
        instruction: validateParams(batchUpdateByAIParamSchema, instruction, 'table.batchUpdateByAI'),
      }),
    searchSemantic: (params: {
      query: string;
      table_id?: string;
      limit?: number;
    }): Promise<any[]> =>
      this.call('table.searchSemantic', validateParams(searchSemanticParamsSchema, params, 'table.searchSemantic')),
    /** Restore data from a `snapshot_id` returned by `deduplicateTable`/`batchDeleteRows`/`batchUpdateByAI`. */
    rollback: (snapshotId: string): Promise<any> =>
      this.call('table.rollback', {
        snapshot_id: validateParams(rollbackParamSchema, snapshotId, 'table.rollback'),
      }),
    getAllTables: (params?: { workspace_id?: string; project_id?: string }): Promise<any[]> =>
      this.call('table.getAllTables', validateParams(getAllTablesParamsSchema, params ?? {}, 'table.getAllTables')),
    getTableStats: (params: { table_id: string; workspace_id?: string; project_id?: string }): Promise<any> =>
      this.call('table.getTableStats', validateParams(tableIdScopedParamsSchema, params, 'table.getTableStats')),
    countRows: (params: { table_id: string; workspace_id?: string; project_id?: string }): Promise<number> =>
      this.call('table.countRows', validateParams(tableIdScopedParamsSchema, params, 'table.countRows')),
    exportTable: (params: { table_id: string; workspace_id?: string; project_id?: string }): Promise<any> =>
      this.call('table.exportTable', validateParams(tableIdScopedParamsSchema, params, 'table.exportTable')),
    deduplicateTable: (params: {
      table_id: string;
      workspace_id?: string;
      project_id?: string;
      strategy?: any;
    }): Promise<any> =>
      this.call('table.deduplicateTable', validateParams(deduplicateTableParamsSchema, params, 'table.deduplicateTable')),
    backfillColumn: (params: {
      table_id: string;
      workspace_id?: string;
      project_id?: string;
      column_key: string;
      default_value?: any;
    }): Promise<any> =>
      this.call('table.backfillColumn', validateParams(backfillColumnParamsSchema, params, 'table.backfillColumn')),
    formatRowsForContext: (params: {
      table_id: string;
      workspace_id?: string;
      project_id?: string;
      query?: string;
      token_budget?: number;
    }): Promise<string> =>
      this.call('table.formatRowsForContext', validateParams(formatRowsForContextParamsSchema, params, 'table.formatRowsForContext')),
  };

  /**
   * `update`/`getById`/`delete` fixed to send `task_id` (matching the backend's real
   * `get task()`) - they previously sent `id`, which the real `task.updateTask`/`getTaskById`/
   * `deleteTask` handlers don't read, so those calls were silently broken. `gen`/`addComment`/
   * `requestSupport` confirmed against the backend's real implementation.
   */
  readonly task = {
    create: (params: {
      title: string;
      content?: string;
      assignee_id?: string;
      workspace_id: string;
      due_date?: string;
    }): Promise<Task> => this.call('task.createTask', params),
    update: (taskId: string, data: { status?: string; content?: string }): Promise<Task> =>
      this.call('task.updateTask', { task_id: taskId, ...data }),
    getById: (taskId: string): Promise<Task> => this.call('task.getTaskById', { task_id: taskId }),
    list: (params: {
      workspace_id: string;
      status?: string;
      assignee_id?: string;
      limit?: number;
    }): Promise<Task[]> => this.call('task.getTasks', params),
    delete: (taskId: string): Promise<any> => this.call('task.deleteTask', { task_id: taskId }),
    listMine: (params?: { status?: string; limit?: number; [key: string]: any }): Promise<Task[]> =>
      this.call('task.listMyTasks', params),
    gen: (params: { prompt?: string; title?: string; workspace_id?: string; task_id?: string }): Promise<Task> =>
      this.call('task.genTask', params),
    addComment: (params: { task_id: string; content: string }): Promise<any> =>
      this.call('task.addTaskComment', params),
    requestSupport: (params: {
      task_id: string;
      assist_user_id: string;
      message: string;
    }): Promise<{ success: boolean; task_id: string; assist_user_id: string }> =>
      this.call('task.requestTaskSupport', params),
  };

  readonly message = {
    /** Real `saveMessage` reads `text`, not `content` (fixed - see the backend's real `get message()`). */
    save: (params: {
      text: string;
      role?: 'user' | 'assistant' | 'system';
      session_id?: string;
    }): Promise<void> => this.call('message.saveMessage', params),
    getList: (params: { session_id: string; limit?: number; [key: string]: any }): Promise<any[]> =>
      this.call('message.getMessageList', params),
    getRecent: (params?: { session_id?: string; limit?: number }): Promise<any[]> =>
      this.call('message.getRecentMessages', params),
    getById: (params: { message_id: string }): Promise<any> =>
      this.call('message.getMessageById', params),
    search: (params: {
      query?: string;
      session_id?: string;
      limit?: number;
      [key: string]: any;
    }): Promise<any[]> => this.call('message.searchMessages', params),
    update: (params: { message_id: string; [key: string]: any }): Promise<any> =>
      this.call('message.updateMessage', params),
    init: (params: { session_id?: string; [key: string]: any }): Promise<any> =>
      this.call('message.initMessage', params),
    stream: (params: {
      session_id?: string;
      thread_id?: string;
      role?: 'user' | 'assistant' | 'system';
      text: string;
      [key: string]: any;
    }): Promise<any> => this.call('message.streamResponse', params),
  };

  readonly notification = {
    /**
     * Multi-channel notification dispatch (in-app push, DB/Notification Center, internal message,
     * email) via the backend's own notification pipeline.
     *
     * `user_id`/`body` here are remapped to the fields the backend actually reads (`receiver_id`/
     * `message`) before the call leaves the client - see `pushNotificationParamsSchema` in
     * `validation.ts` for the full story: sending `user_id`/`body` untranslated used to
     * round-trip successfully while silently delivering to nobody (audience) and dropping the text
     * (content). `receiver_id`/`message` are also accepted directly and take precedence if you
     * pass them explicitly. Use `receiver_ids` (batch) or `topic` (broadcast to that topic's
     * subscribers - see `subscribeTopic`/`unsubscribeTopic` below) instead of `user_id` for other
     * audience shapes; at least one audience field is required (validated locally). Omit
     * `title`/`body` and pass `prompt` instead to have the backend AI-generate localized
     * title/message content for you. `channels` restricts delivery to specific channels;
     * `priority` controls which engines are eligible in the first place (channels only filters
     * further, it doesn't override priority - e.g. `channels: ['email']` still needs
     * `priority: 'high'` or `'urgent'` to make EmailEngine eligible at all).
     */
    push: (params: {
      user_id?: string;
      receiver_ids?: string[];
      topic?: string;
      sender_id?: string;
      title?: string;
      body?: string;
      prompt?: string;
      title_key?: string;
      message_key?: string;
      vars?: Record<string, any>;
      messageIsHtml?: boolean;
      priority?: 'low' | 'normal' | 'high' | 'urgent';
      channels?: ('database' | 'push' | 'message' | 'email')[];
      type?: string;
      [key: string]: any;
    }): Promise<void> => {
      const { user_id, body, ...rest } = validateParams(pushNotificationParamsSchema, params, 'notification.push');
      return this.call('notification.pushNotification', {
        ...rest,
        receiver_id: rest.receiver_id ?? user_id,
        message: rest.message ?? body,
      });
    },
    /**
     * NOTE: unlike `push()`, this does NOT support a per-workspace SMTP override - the backend's
     * `notification.sendMail` handler destructures only `to`/`subject`/`html`/`body` and sends
     * directly, ignoring any other field (including `workspace_id`/`cert`) passed here. If you need
     * workspace-scoped SMTP, use `push()` with `channels: ['email']` and `priority: 'high'`/`'urgent'`
     * instead - that path does read `workspace_id`.
     */
    sendMail: (params: {
      to: string;
      subject: string;
      body: string;
      [key: string]: any;
    }): Promise<void> => this.call('notification.sendMail', params),
    subscribeTopic: (params: { topic: string; user_id?: string }): Promise<void> =>
      this.call('notification.subscribeTopic', params),
    unsubscribeTopic: (params: { topic: string; user_id?: string }): Promise<void> =>
      this.call('notification.unsubscribeTopic', params),
  };

  readonly realtime = {
    publish: (params: {
      event: string;
      data: any;
      target?: 'workspace' | 'user';
    }): Promise<{ success: boolean; delivered_to: string | null }> =>
      this.call('realtime.publish', params),
  };

  readonly queue = {
    scheduleJob: (params: {
      input: Record<string, any>;
      delay_ms?: number;
    }): Promise<{ job_id: string }> => this.call('queue.scheduleJob', params),
  };

  readonly usage = {
    checkBalance: (params?: { workspace_id?: string }): Promise<any> =>
      this.call('usage.checkBalance', params),
    getUsage: (params?: { workspace_id?: string; period?: string }): Promise<any> =>
      this.call('usage.getUsage', params),
  };

  /**
   * Verified against the real `JobRequest`/`JobListRequest`/`JobResponse` shapes on the backend -
   * a previous pass of this SDK had guessed at `{ name, schedule, logic }`, none of which are real field names on the
   * backend (the real fields are `mission`/`schedule_condition`; there is no `logic` field at all -
   * a job's executable content is `prompt`/`workflow`, not a code string).
   *
   * Every method here validates `params` against a zod schema (`validation.ts`) BEFORE the call
   * goes out - this is the namespace where a shape mistake previously shipped silently (a wrong
   * field name doesn't error, it just gets ignored, so the job schedule/mission ends up wrong with
   * no signal at the call site). A caught mistake here throws immediately with a clear message
   * instead of round-tripping to the host to fail later or not at all.
   */
  readonly automation = {
    createJob: (params: {
      /** Short display name for the job - the real field the backend reads (not `name`). */
      mission: string;
      /** Full original request - source of truth for schedule inference/workflow generation when
       *  set; falls back to `mission` if omitted. */
      prompt?: string;
      /** Required on this call path - unlike most other namespaces, NOT auto-filled from `ctx`. */
      agent_id: string;
      /** Optional here only because the backend falls back to `ctx.workspace`/`ctx.session` when
       *  omitted - explicit is safer if this invocation might not have either attached. */
      workspace_id?: string;
      project_id?: string;
      /** Natural-language schedule (e.g. "every 5 minutes", "daily at 9am") - NOT a raw cron
       *  string; the backend parses this itself. Omit entirely for a manually-triggered job. */
      schedule_condition?: string;
      workflow?: any;
      plugin_id?: string;
      fresh_execution?: boolean;
    }): Promise<AutomationJob> =>
      this.call('automation.createJob', validateParams(createJobParamsSchema, params, 'automation.createJob')),
    updateJob: (params: {
      /** Job id - `job_id` is also accepted as an alias by the backend. */
      id: string;
      mission?: string;
      schedule_condition?: string;
      workflow?: any;
      project_id?: string;
      agent_id?: string;
      plugin_id?: string;
      fresh_execution?: boolean;
      /** Any other key is passed through but NOT read by the backend's recognized-fields list
       *  (`mission`/`workflow`/`project_id`/`agent_id`/`fresh_execution`/`plugin_id`/
       *  `schedule_condition`) - silently ignored rather than erroring, so don't rely on it. */
      [key: string]: any;
    }): Promise<AutomationJob> =>
      this.call('automation.updateJob', validateParams(updateJobParamsSchema, params, 'automation.updateJob')),
    getJobs: (params: {
      /** Required - the backend's permission check needs it even though it's typed optional-looking
       *  here for callers that always have a workspace in `ctx`. */
      workspace_id: string;
      /** `'workspace'` = every job in the workspace (requires workspace-admin permission);
       *  omitted/`'personal'` = only jobs the caller created. */
      mode?: 'workspace' | 'personal';
      search?: string;
      limit?: number;
      offset?: number;
    }): Promise<AutomationJob[]> =>
      this.call('automation.getJobs', validateParams(getJobsParamsSchema, params, 'automation.getJobs')),
    deleteJob: (params: { id: string }): Promise<void> =>
      this.call('automation.deleteJob', validateParams(deleteJobParamsSchema, params, 'automation.deleteJob')),
    /** Manual out-of-schedule trigger. Only the calling user's own job can be triggered this way -
     *  rejected with 403 otherwise. */
    executeById: (id: string): Promise<{ status: string; job_id: string }> =>
      this.call('automation.executeById', {
        id: validateParams(executeByIdParamSchema, id, 'automation.executeById'),
      }),
  };

  /**
   * `file`'s accepted shapes and the `ResourceMeta` return type verified against the backend's real
   * implementation - previously typed `file: any` and `Promise<any>` with no confirmed
   * shape for either. `upload`'s zod schema is what actually enforces the 3-shapes-only rule on
   * `file` at the call site (see `validation.ts`) - a 4th shape (e.g. a raw `Buffer`) is rejected
   * immediately with a clear message instead of failing obscurely on the host.
   */
  readonly resource = {
    upload: (params: {
      /** Base64-encoded string, a `{type:'Buffer',data:number[]}` object (a `Buffer`'s own
       *  `JSON.stringify` shape), or a plain `number[]` - a raw `Buffer` instance itself does NOT
       *  survive the gRPC call's JSON round-trip, so send one of these three instead. */
      file: string | { type: 'Buffer'; data: number[] } | number[];
      name?: string;
      mime?: string;
      /** Default `false` (private) - only becomes publicly accessible if set `true` explicitly. */
      is_public?: boolean;
      /** `true` = auto-deleted after a period of time (temp upload cleanup) - see `expire_at` on
       *  the returned `ResourceMeta`. */
      temp?: boolean;
      /** Falls back to `ctx.workspace` if omitted - only needed when this invocation has no
       *  workspace attached. */
      workspace_id?: string;
    }): Promise<ResourceMeta> =>
      this.call('resource.uploadFile', validateParams(uploadParamsSchema, params, 'resource.upload')),
    remove: (params: { url: string }): Promise<any> =>
      this.call('resource.removeFile', validateParams(removeParamsSchema, params, 'resource.remove')),
  };

  readonly session = {
    get: (session_id: string): Promise<MessageSession> =>
      this.call('session.getSession', { session_id }),
    getList: (params?: {
      workspace_id?: string;
      user_id?: string;
      limit?: number;
      [key: string]: any;
    }): Promise<MessageSession[]> => this.call('session.getSessionList', params),
    markAsSeen: (params: {
      session_id: string;
      workspace_id: string;
      user_id: string;
    }): Promise<any> => this.call('session.markSessionAsSeen', params),
    update: (params: { id: string; [key: string]: any }): Promise<any> =>
      this.call('session.updateSession', params),
    newSession: (params: Record<string, any>): Promise<MessageSession> =>
      this.call('session.newSession', params),
    create: (params: Record<string, any>): Promise<MessageSession> =>
      this.call('session.createSession', params),
    updateStatus: (params: {
      session_id: string;
      status: 'idle' | 'processing' | 'completed';
    }): Promise<any> => this.call('session.updateSessionStatus', params),
    updateAgent: (params: { session_id: string; agent_id: string; info?: any }): Promise<any> =>
      this.call('session.updateSessionAgent', params),
  };

  readonly code = {
    /** Executes arbitrary "business logic" (AI-generated/cached code) with sandboxed args. */
    executeLogic: (params: {
      logic: string;
      args?: any;
      input_schema?: Record<string, string>;
    }): Promise<any> => this.call('code.executeLogic', params),
  };

  readonly file = {
    create: (fileData: Record<string, any>): Promise<any> => this.call('file.createFile', fileData),
    get: (id: string): Promise<any> => this.call('file.getFile', { file_id: id }),
    del: (id: string): Promise<any> => this.call('file.deleteFile', { file_id: id }),
    list: (params?: { limit?: number; offset?: number }): Promise<any[]> =>
      this.call('file.listFiles', params),
    search: (query: string, opts?: { file_ids?: string[]; limit?: number }): Promise<any[]> =>
      this.call('file.searchFiles', { query, ...opts }),
  };

  readonly setting = {
    get: (params?: { lang?: string }): Promise<any> => this.call('setting.getSetting', params),
    getMerchantConfig: (params?: Record<string, never>): Promise<any> =>
      this.call('setting.getMerchantConfig', params),
  };

  /**
   * Relational key-value store with graph edges + semantic/keyword/hybrid search.
   * Data is scoped to this plugin + tenant on the host side.
   *
   * Every method validates the outbound request against a zod schema (`validation.ts`) before the
   * call goes out - verified field-by-field against the backend's real implementation (all correct
   * already; this adds the runtime guard against future drift, not a shape fix).
   */
  readonly store = {
    set: (
      table: string,
      key: string,
      data: Record<string, any>,
      ttlSeconds?: number,
      schema?: {
        name: string;
        description?: string;
        columns: Array<{ key: string; name: string; type: string; options?: string[] }>;
      },
      options?: { strict?: boolean },
    ): Promise<any> =>
      this.call(
        'store.set',
        validateParams(
          storeSetParamsSchema,
          { table_id: table, key, data, ttl_seconds: ttlSeconds, schema, strict: options?.strict },
          'store.set',
        ),
      ),
    get: (table: string, key: string): Promise<any | null> =>
      this.call('store.get', validateParams(storeGetParamsSchema, { table_id: table, key }, 'store.get')),
    del: (table: string, key: string): Promise<{ deleted: boolean }> =>
      this.call('store.delete', validateParams(storeDeleteParamsSchema, { table_id: table, key }, 'store.del')),
    bulk: (
      table: string,
      rows: Array<{ key: string; data: Record<string, any>; ttlSeconds?: number }>,
      schema?: any,
    ): Promise<{ success: number; failed: number }> =>
      this.call(
        'store.bulkSet',
        validateParams(storeBulkParamsSchema, { table_id: table, rows, schema }, 'store.bulk'),
      ),
    query: (
      table: string,
      filter?: Record<string, any>,
      sort?: Record<string, 1 | -1>,
      limit?: number,
      page?: number,
    ): Promise<any[]> =>
      this.call(
        'store.query',
        validateParams(storeQueryParamsSchema, { table_id: table, filter, sort, limit, page }, 'store.query'),
      ),
    count: (table: string, filter?: Record<string, any>): Promise<number> =>
      this.call('store.count', validateParams(storeCountParamsSchema, { table_id: table, filter }, 'store.count')),
    search: (
      table: string,
      query: string,
      options?: { mode?: 'semantic' | 'keyword' | 'hybrid'; limit?: number; threshold?: number },
    ): Promise<Array<any & { _similarity: number }>> =>
      this.call(
        'store.search',
        validateParams(storeSearchParamsSchema, { table_id: table, query, ...options }, 'store.search'),
      ),
    aggregate: (
      table: string,
      metrics: Array<{ op: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string; as: string }>,
      options?: {
        groupBy?: string;
        filter?: Record<string, any>;
        sort?: Record<string, 1 | -1>;
        limit?: number;
      },
    ): Promise<any[]> =>
      this.call(
        'store.aggregate',
        validateParams(
          storeAggregateParamsSchema,
          {
            table_id: table,
            metrics,
            group_by: options?.groupBy,
            filter: options?.filter,
            sort: options?.sort,
            limit: options?.limit,
          },
          'store.aggregate',
        ),
      ),
    cursor: (
      table: string,
      filter?: Record<string, any>,
      options?: { sort?: Record<string, 1 | -1>; limit?: number; after?: string },
    ): Promise<{ rows: any[]; next: string | null }> =>
      this.call(
        'store.cursor',
        validateParams(storeCursorParamsSchema, { table_id: table, filter, ...options }, 'store.cursor'),
      ),
    /** Each operation gets a `table_id` alias of `table` added (matching the backend's real shape)
     * - the real handler reads `table_id`, so omitting it silently dropped every operation. */
    transaction: (
      operations: Array<
        | { op: 'set'; table: string; key: string; data: Record<string, any>; ttlSeconds?: number }
        | { op: 'del'; table: string; key: string }
      >,
    ): Promise<void> =>
      this.call(
        'store.transaction',
        validateParams(
          storeTransactionParamsSchema,
          { operations: operations.map((op) => ({ ...op, table_id: op.table })) },
          'store.transaction',
        ),
      ),
    join: (params: {
      from: { table: string; filter?: Record<string, any> };
      to: { table: string; filter?: Record<string, any> };
      on: string;
      embed?: string;
      limit?: number;
      page?: number;
    }): Promise<any[]> =>
      this.call(
        'store.join',
        validateParams(
          storeJoinParamsSchema,
          {
            from_table: params.from.table,
            from_filter: params.from.filter,
            to_table: params.to.table,
            to_filter: params.to.filter,
            on: params.on,
            embed: params.embed,
            limit: params.limit,
            page: params.page,
          },
          'store.join',
        ),
      ),
    link: (
      sourceTable: string,
      sourceKey: string,
      targetTable: string,
      targetKey: string,
      linkType?: string,
      data?: Record<string, any>,
    ): Promise<any> =>
      this.call(
        'store.link',
        validateParams(
          storeLinkParamsSchema,
          {
            source_table: sourceTable,
            source_key: sourceKey,
            target_table: targetTable,
            target_key: targetKey,
            link_type: linkType,
            data,
          },
          'store.link',
        ),
      ),
    unlink: (
      sourceTable: string,
      sourceKey: string,
      targetTable: string,
      targetKey: string,
      linkType?: string,
    ): Promise<{ deleted: number }> =>
      this.call(
        'store.unlink',
        validateParams(
          storeUnlinkParamsSchema,
          {
            source_table: sourceTable,
            source_key: sourceKey,
            target_table: targetTable,
            target_key: targetKey,
            link_type: linkType,
          },
          'store.unlink',
        ),
      ),
    getLinks: (
      sourceTable: string,
      sourceKey: string,
      options?: { targetTable?: string; type?: string; reverse?: boolean; limit?: number },
    ): Promise<
      Array<{
        id: string;
        source_table: string;
        source_key: string;
        target_table: string;
        target_key: string;
        link_type: string;
        data: Record<string, any>;
        created_at: Date;
      }>
    > =>
      this.call(
        'store.getLinks',
        validateParams(
          storeGetLinksParamsSchema,
          {
            source_table: sourceTable,
            source_key: sourceKey,
            target_table: options?.targetTable,
            link_type: options?.type,
            reverse: options?.reverse,
            limit: options?.limit,
          },
          'store.getLinks',
        ),
      ),
  };

  /**
   * Isolated key-value storage backed by Redis on the host, scoped to this plugin + tenant.
   * Namespace confirmed against the backend's real registration - NOT a direct Redis connection
   * (Docker-runtime plugins never receive raw Redis/Mongo credentials).
   */
  readonly redis = {
    get: (key: string): Promise<string | null> => this.call('storage.redisGet', { key }),
    /** Backend's `redisSet` returns `{ success: true }`, not the raw `'OK'` this promises (ioredis
     *  convention) - unwrapped here so the declared return type is actually true at runtime, not
     *  just documentation. Same for every other method below whose backend handler wraps its
     *  result in an object instead of returning the primitive ioredis itself would. */
    set: (key: string, value: string | number | Buffer): Promise<'OK'> =>
      this.call('storage.redisSet', { key, value }).then(() => 'OK' as const),
    setex: (key: string, seconds: number, value: string | number | Buffer): Promise<'OK'> =>
      this.call('storage.redisSet', { key, value, options: { EX: seconds } }).then(() => 'OK' as const),
    /** Backend's `redisDel` doesn't report how many keys actually existed (`{ success: true }`
     *  either way) - this can only report the count of keys *requested*, not keys that actually
     *  existed and were removed (matches ioredis's return shape, not its exact semantics). */
    del: (...keys: string[]): Promise<number> =>
      this.call('storage.redisDel', { key: keys.length === 1 ? keys[0] : keys }).then(() => keys.length),
    /** Backend's `redisHas` only ever checks a single key (`{ exists: boolean }`) even when this is
     *  called with several - passing more than one `key` silently checks just the first. */
    exists: (...keys: string[]): Promise<number> =>
      this.call('storage.redisHas', { key: keys.length === 1 ? keys[0] : keys }).then((r: { exists: boolean }) => (r?.exists ? 1 : 0)),
    incr: (key: string): Promise<number> => this.call('storage.redisIncr', { key }).then((r: { value: number }) => r?.value),
    incrby: (key: string, increment: number): Promise<number> =>
      this.call('storage.redisIncr', { key, amount: increment }).then((r: { value: number }) => r?.value),
    /** Confirmed against the backend's real `redisDecr` handler - previously reachable only via `call()`. */
    decr: (key: string): Promise<number> => this.call('storage.redisDecr', { key }).then((r: { value: number }) => r?.value),
    decrby: (key: string, decrement: number): Promise<number> =>
      this.call('storage.redisDecr', { key, amount: decrement }).then((r: { value: number }) => r?.value),
    hget: (key: string, field: string): Promise<string | null> =>
      this.call('storage.redisHget', { key, field }),
    /** Backend's `redisHset` returns `{ success: true }`, not a real "new fields added" count -
     *  always resolves to 1 on success (matches ioredis's return shape, not its exact semantics). */
    hset: (key: string, field: string, value: string | number): Promise<number> =>
      this.call('storage.redisHset', { key, field, value }).then(() => 1),
    hgetall: (key: string): Promise<Record<string, string>> =>
      this.call('storage.redisHgetall', { key }),
    hdel: (key: string, ...fields: string[]): Promise<number> =>
      this.call('storage.redisHdel', { key, field: fields.length === 1 ? fields[0] : fields }).then(
        (r: { deletedCount: number }) => r?.deletedCount,
      ),
    keys: (pattern: string): Promise<string[]> => this.call('storage.redisKeys', { pattern }),
  };

  /**
   * Isolated document storage backed by MongoDB on the host, scoped to this plugin + tenant.
   * Matches the backend's own `mongo: { model(name, schema) }` shape - `model(name)` returns a
   * Mongoose-style handle bound to that collection name; every method on it calls one of the
   * `storage.mongo*` namespaces confirmed against the backend's real registration.
   */
  readonly mongo = {
    model: (name: string, _schema?: any) => {
      const collection = name;
      return {
        create: (doc: Record<string, any>): Promise<any> =>
          this.call('storage.mongoInsert', { collection, doc }),
        insertMany: (docs: Record<string, any>[]): Promise<any> =>
          this.call('storage.mongoInsertMany', { collection, docs }),
        find: (query?: Record<string, any>, options?: Record<string, any>): Promise<any[]> =>
          this.call('storage.mongoFind', { collection, query, options }),
        findOne: (query?: Record<string, any>): Promise<any | null> =>
          this.call('storage.mongoFindOne', { collection, query }),
        countDocuments: (query?: Record<string, any>): Promise<number> =>
          this.call('storage.mongoCount', { collection, query }),
        updateMany: (
          query: Record<string, any>,
          update: Record<string, any>,
          options?: Record<string, any>,
        ): Promise<any> => this.call('storage.mongoUpdate', { collection, query, update, options }),
        updateOne: (
          query: Record<string, any>,
          update: Record<string, any>,
          options?: Record<string, any>,
        ): Promise<any> =>
          this.call('storage.mongoUpdateOne', { collection, query, update, options }),
        findOneAndUpdate: (
          query: Record<string, any>,
          update: Record<string, any>,
          options?: Record<string, any>,
        ): Promise<any> =>
          this.call('storage.mongoFindOneAndUpdate', { collection, query, update, options }),
        findOneAndDelete: (query: Record<string, any>): Promise<any> =>
          this.call('storage.mongoFindOneAndDelete', { collection, query }),
        deleteMany: (query: Record<string, any>): Promise<any> =>
          this.call('storage.mongoDel', { collection, query }),
        deleteOne: (query: Record<string, any>): Promise<any> =>
          this.call('storage.mongoDeleteOne', { collection, query }),
        aggregate: (pipeline: any[]): Promise<any[]> =>
          this.call('storage.mongoAggregate', { collection, pipeline }),
      };
    },
  };
}

export type { ConnectionInfo };
