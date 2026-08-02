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
  updateJobParamsSchema,
  updateTableParamsSchema,
  uploadParamsSchema,
  validateParams,
} from './validation';
import type {
  Agent,
  AgentReplyOptions,
  AutomationJob,
  ConnectionInfo,
  LLMPromptOptions,
  MessageSession,
  PluginContext,
  ResourceMeta,
  Task,
  User,
  Workspace,
} from '../types/SDKTypes';

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

/**
 * Client-side implementation of the platform's unified SDK surface.
 *
 * Mirrors `src/plugins/sdk/CodeSDK.d.ts` on the backend (the single source of truth for what a
 * plugin can call). Every method - generic `call()` and the typed sugar objects below - goes
 * through the same gRPC `Invoke` RPC (`namespace.method`, params, context), matching exactly how
 * `PluginBridge.call()` dispatches on the host. The `cap` token (see GrpcCapabilityStore on the
 * backend) is threaded into `context.metadata._cap` on every outbound call so the host can resolve
 * this invocation's real tenant/workspace/session identity instead of trusting anything this
 * process claims about itself.
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

  /** Generic escape hatch: call any host namespace directly. */
  async call<T = any>(func: string, params?: any, timeoutMs?: number): Promise<T> {
    return this.invoke<T>({
      namespace: func,
      params,
      context: this.buildContext(),
      timeoutMs: timeoutMs ?? this.defaultTimeoutMs,
    });
  }

  close(): void {
    // No persistent connection to tear down per-call; kept for CodeSDK.d.ts parity.
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
   * Mirrors the real `a2a()` in `src/base/SDK.ts`: if `target` doesn't look like an agent ID
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
    console[level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log'](`[plugin] ${msg}`);
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
  // Docker-runtime plugins observe progress via `realtime.publish` instead. Kept for CodeSDK.d.ts
  // shape parity but intentionally unimplemented here - throws so callers fail loudly, not silently.
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

  // ── Namespace sugar objects (mirrors CodeSDK.d.ts) ────────────────────

  /**
   * Param shapes verified against the backend's real `src/base/SDK.ts` (`get ai()`), not just
   * `CodeSDK.d.ts` (which diverges from the actual implementation in several places - e.g. it
   * declares `getEmbeddings({texts, opts})` and `rerank({query, docs, ...opts})`, but the real
   * code takes `getEmbeddings(texts, opts)` and nests rerank's options under `opts`).
   * `tts`/`stt`/`getModels`/`calculateTokens` confirmed against `AISDK.ts`'s `register(...)` calls.
   */
  readonly ai = {
    prompt: (quest: string | any[], opts?: LLMPromptOptions): Promise<any> =>
      this.call('ai.prompt', { quest, opts }),
    /**
     * Streaming counterpart of `prompt()` - text deltas arrive as they're generated instead of
     * waiting for the whole response, same shape as Vercel AI SDK's `streamText()`:
     * ```ts
     * const result = ctx.sdk.ai.promptStream("write a haiku");
     * for await (const delta of result.textStream) process.stdout.write(delta);
     * const full = await result.text; // full text, resolves once the stream ends
     * ```
     * Falls back to a single "chunk" (the whole response, then done) if the model/provider
     * resolved server-side doesn't support token-level streaming - `textStream` and `text` behave
     * the same either way, just with coarser granularity.
     */
    promptStream: (quest: string | any[], opts?: LLMPromptOptions): { textStream: AsyncIterable<string>; text: Promise<string> } => {
      const handle = this.invokeStream<string>({
        namespace: 'ai.promptStream',
        params: { quest, opts },
        context: this.buildContext(),
        timeoutMs: this.defaultTimeoutMs,
      });
      return { textStream: handle.chunks, text: handle.final };
    },
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
  };

  /**
   * `search`/`reinforce` confirmed against `BrainSDK.ts`'s `registerKnowledgeHandlers()`.
   * `get`/`del` now confirmed real too (same file, `knowledge.batchGetKnowledge`/
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

  readonly vector = {
    search: (params: {
      query: string;
      type?: string;
      limit?: number;
      threshold?: number;
    }): Promise<any[]> => this.call('vector.searchDocuments', params),
    index: (params: {
      content: string;
      type?: string;
      id?: string;
      metadata?: Record<string, unknown>;
    }): Promise<void> => this.call('vector.indexDocument', params),
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
   * Matches the real `get causality()` in `src/base/SDK.ts` exactly (`think`/`absorb`, params
   * spread directly into the call, not nested under `mission`/`context`). There is no separate
   * `think` namespace with `deep`/`search` on the real SDK - that was invented from CodeSDK.d.ts's
   * declared-but-unimplemented `think.*` overloads.
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
   * `ask`/`hil` are NOT on the real `get agent()` in `src/base/SDK.ts` - only standalone
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
     * `AIBrowserService.triggerMission` on the backend, bypassing the suspend/resume plumbing that
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
  };

  readonly project = {
    get: (params: { id: string }): Promise<any> => this.call('project.getProject', params),
    search: (params: { workspace_id?: string; keyword?: string }): Promise<any[]> =>
      this.call('project.searchProject', params),
  };

  /**
   * `updateRow`/`deleteRow`/`smartQuery`/`batchUpdateByAI` fixed to match the real, simpler
   * signatures in `src/base/SDK.ts`'s `get datastore()` (no `workspace_id`/`project_id`/`ctx` -
   * those are resolved server-side from the caller's identity, not passed by the client). Added
   * `ensureTable`/`getRow`, both confirmed there but missing here before.
   *
   * Every method validates `params` against a zod schema (`validation.ts`) before the call goes
   * out - verified field-by-field against the real `DatastoreSDK.ts` (all correct already; this
   * adds the runtime guard against future drift, not a shape fix).
   */
  readonly datastore = {
    ensureTable: (params: {
      purpose: string;
      workspace_id?: string;
      project_id?: string;
      target_columns?: string[];
    }): Promise<any> =>
      this.call('datastore.ensureTable', validateParams(ensureTableParamsSchema, params, 'datastore.ensureTable')),
    createTable: (params: {
      workspace_id: string;
      project_id: string;
      name: string;
      description?: string;
      columns: any[];
      primary_id?: string;
      primary_key_column?: string;
    }): Promise<any> =>
      this.call('datastore.createTable', validateParams(createTableParamsSchema, params, 'datastore.createTable')),
    getTables: (params: { workspace_id: string; project_id: string }): Promise<any[]> =>
      this.call('datastore.getTables', validateParams(getTablesParamsSchema, params, 'datastore.getTables')),
    getTable: (params: { workspace_id: string; table_id: string }): Promise<any> =>
      this.call('datastore.getTable', validateParams(getTableParamsSchema, params, 'datastore.getTable')),
    updateTable: (params: {
      workspace_id: string;
      table_id: string;
      name?: string;
      description?: string;
      columns?: any[];
      primary_id?: string;
      primary_key_column?: string;
    }): Promise<any> =>
      this.call('datastore.updateTable', validateParams(updateTableParamsSchema, params, 'datastore.updateTable')),
    deleteTable: (params: { workspace_id: string; table_id: string }): Promise<any> =>
      this.call('datastore.deleteTable', validateParams(deleteTableParamsSchema, params, 'datastore.deleteTable')),
    addRow: (params: {
      workspace_id: string;
      project_id: string;
      table_id: string;
      data: Record<string, any>;
    }): Promise<any> =>
      this.call('datastore.addRow', validateParams(addRowParamsSchema, params, 'datastore.addRow')),
    getRow: (rowId: string): Promise<any> =>
      this.call('datastore.getRow', { id: validateParams(z.string().min(1, 'rowId is required'), rowId, 'datastore.getRow') }),
    updateRow: (rowId: string, data: Record<string, any>): Promise<any> =>
      this.call('datastore.updateRow', {
        row_id: validateParams(z.string().min(1, 'rowId is required'), rowId, 'datastore.updateRow'),
        ...data,
      }),
    deleteRow: (rowId: string): Promise<any> =>
      this.call('datastore.deleteRow', { row_id: validateParams(z.string().min(1, 'rowId is required'), rowId, 'datastore.deleteRow') }),
    getRows: (params: {
      workspace_id: string;
      project_id: string;
      table_id: string;
      filter?: Record<string, any>;
      sort?: Record<string, any>;
      page?: number;
      limit?: number;
    }): Promise<any[]> =>
      this.call('datastore.getRows', validateParams(getRowsParamsSchema, params, 'datastore.getRows')),
    batchUpdateRows: (params: {
      workspace_id: string;
      project_id: string;
      table_id: string;
      filter: Record<string, any>;
      update: Record<string, any>;
    }): Promise<any> =>
      this.call('datastore.batchUpdateRows', validateParams(batchUpdateRowsParamsSchema, params, 'datastore.batchUpdateRows')),
    batchDeleteRows: (ids: string[]): Promise<any> =>
      this.call('datastore.batchDeleteRows', {
        ids: validateParams(batchDeleteRowsParamsSchema, ids, 'datastore.batchDeleteRows'),
      }),
    bulkAddRows: (params: {
      workspace_id: string;
      project_id: string;
      table_id: string;
      rows: Record<string, any>[];
    }): Promise<any> =>
      this.call('datastore.bulkAddRows', validateParams(bulkAddRowsParamsSchema, params, 'datastore.bulkAddRows')),
    smartQuery: (query: string): Promise<any> =>
      this.call('datastore.smartQuery', { query: validateParams(smartQueryParamSchema, query, 'datastore.smartQuery') }),
    batchUpdateByAI: (instruction: string): Promise<any> =>
      this.call('datastore.batchUpdateByAI', {
        instruction: validateParams(batchUpdateByAIParamSchema, instruction, 'datastore.batchUpdateByAI'),
      }),
    searchSemantic: (params: {
      query: string;
      table_id?: string;
      limit?: number;
    }): Promise<any[]> =>
      this.call('datastore.searchSemantic', validateParams(searchSemanticParamsSchema, params, 'datastore.searchSemantic')),
    /** Restore data from a `snapshot_id` returned by `deduplicateTable`/`batchDeleteRows`/`batchUpdateByAI`. */
    rollback: (snapshotId: string): Promise<any> =>
      this.call('datastore.rollback', {
        snapshot_id: validateParams(rollbackParamSchema, snapshotId, 'datastore.rollback'),
      }),
    getAllTables: (params?: { workspace_id?: string; project_id?: string }): Promise<any[]> =>
      this.call('datastore.getAllTables', validateParams(getAllTablesParamsSchema, params ?? {}, 'datastore.getAllTables')),
    getTableStats: (params: { table_id: string; workspace_id?: string; project_id?: string }): Promise<any> =>
      this.call('datastore.getTableStats', validateParams(tableIdScopedParamsSchema, params, 'datastore.getTableStats')),
    countRows: (params: { table_id: string; workspace_id?: string; project_id?: string }): Promise<number> =>
      this.call('datastore.countRows', validateParams(tableIdScopedParamsSchema, params, 'datastore.countRows')),
    exportTable: (params: { table_id: string; workspace_id?: string; project_id?: string }): Promise<any> =>
      this.call('datastore.exportTable', validateParams(tableIdScopedParamsSchema, params, 'datastore.exportTable')),
    deduplicateTable: (params: {
      table_id: string;
      workspace_id?: string;
      project_id?: string;
      strategy?: any;
    }): Promise<any> =>
      this.call('datastore.deduplicateTable', validateParams(deduplicateTableParamsSchema, params, 'datastore.deduplicateTable')),
    backfillColumn: (params: {
      table_id: string;
      workspace_id?: string;
      project_id?: string;
      column_key: string;
      default_value?: any;
    }): Promise<any> =>
      this.call('datastore.backfillColumn', validateParams(backfillColumnParamsSchema, params, 'datastore.backfillColumn')),
    formatRowsForContext: (params: {
      table_id: string;
      workspace_id?: string;
      project_id?: string;
      query?: string;
      token_budget?: number;
    }): Promise<string> =>
      this.call('datastore.formatRowsForContext', validateParams(formatRowsForContextParamsSchema, params, 'datastore.formatRowsForContext')),
  };

  /**
   * `update`/`getById`/`delete` fixed to send `task_id` (matching `src/base/SDK.ts`'s real
   * `get task()`) - they previously sent `id`, which the real `task.updateTask`/`getTaskById`/
   * `deleteTask` handlers don't read, so those calls were silently broken. `gen`/`addComment`/
   * `requestSupport` confirmed against `TaskSDK.ts`.
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
    /** Real `saveMessage` reads `text`, not `content` (fixed - see `src/base/SDK.ts`'s `get message()`). */
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

  /**
   * `push`/`sendMail` param shapes fixed to match the real `get notification()` in
   * `src/base/SDK.ts`: single `user_id` (not `user_ids`) and `body` (not `content`/`html`).
   */
  readonly notification = {
    push: (params: {
      user_id: string;
      title: string;
      body: string;
      [key: string]: any;
    }): Promise<void> => this.call('notification.pushNotification', params),
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
   * Verified against the real `JobRequest`/`JobListRequest`/`JobResponse` in the backend's
   * `AutomationDTO.ts` (via `AutomationSDK.ts`'s PluginBridge handlers) - a previous pass of this
   * SDK had guessed at `{ name, schedule, logic }`, none of which are real field names on the
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
   * `ResourceSDK.ts`/`FSIO.ts` - previously typed `file: any` and `Promise<any>` with no confirmed
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
   * Data is scoped to this plugin + tenant on the host side - see CodeSDK.d.ts `store`.
   *
   * Every method validates the outbound request against a zod schema (`validation.ts`) before the
   * call goes out - verified field-by-field against the real `StoreSDK.ts` (all correct already;
   * this adds the runtime guard against future drift, not a shape fix).
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
    /** Each operation gets a `table_id` alias of `table` added (matching `src/base/SDK.ts` exactly)
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
   * Namespace confirmed against `PluginStorageService.sdkMethods(this, 'storage', [...])` on
   * the backend - NOT a direct Redis connection (Docker-runtime plugins never receive raw
   * Redis/Mongo credentials, see DockerHelper's `generateStackEnvOverrides` comment).
   */
  readonly redis = {
    get: (key: string): Promise<string | null> => this.call('storage.redisGet', { key }),
    set: (key: string, value: string | number | Buffer): Promise<'OK'> =>
      this.call('storage.redisSet', { key, value }),
    setex: (key: string, seconds: number, value: string | number | Buffer): Promise<'OK'> =>
      this.call('storage.redisSet', { key, value, options: { EX: seconds } }),
    del: (...keys: string[]): Promise<number> =>
      this.call('storage.redisDel', { key: keys.length === 1 ? keys[0] : keys }),
    exists: (...keys: string[]): Promise<number> =>
      this.call('storage.redisHas', { key: keys.length === 1 ? keys[0] : keys }),
    incr: (key: string): Promise<number> => this.call('storage.redisIncr', { key }),
    incrby: (key: string, increment: number): Promise<number> =>
      this.call('storage.redisIncr', { key, amount: increment }),
    /** Confirmed against `PluginStorageService.redisDecr` - previously reachable only via `call()`. */
    decr: (key: string): Promise<number> => this.call('storage.redisDecr', { key }),
    decrby: (key: string, decrement: number): Promise<number> =>
      this.call('storage.redisDecr', { key, amount: decrement }),
    hget: (key: string, field: string): Promise<string | null> =>
      this.call('storage.redisHget', { key, field }),
    hset: (key: string, field: string, value: string | number): Promise<number> =>
      this.call('storage.redisHset', { key, field, value }),
    hgetall: (key: string): Promise<Record<string, string>> =>
      this.call('storage.redisHgetall', { key }),
    hdel: (key: string, ...fields: string[]): Promise<number> =>
      this.call('storage.redisHdel', { key, field: fields.length === 1 ? fields[0] : fields }),
    keys: (pattern: string): Promise<string[]> => this.call('storage.redisKeys', { pattern }),
  };

  /**
   * Isolated document storage backed by MongoDB on the host, scoped to this plugin + tenant.
   * Matches CodeSDK.d.ts's `mongo: { model(name, schema) }` shape - `model(name)` returns a
   * Mongoose-style handle bound to that collection name; every method on it calls one of the
   * `storage.mongo*` namespaces confirmed against `PluginStorageService` on the backend.
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
