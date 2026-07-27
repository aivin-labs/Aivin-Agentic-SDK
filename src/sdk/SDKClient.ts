import { invokeHost } from '../grpc/GrpcInvoker';
import type {
  Agent,
  ConnectionInfo,
  LLMPromptOptions,
  MessageSession,
  PluginContext,
  Task,
  User,
  Workspace,
} from '../types/SDKTypes';

export interface SDKClientOptions {
  /** Per-invocation capability token minted by the host (context.metadata._cap on the inbound Invoke). */
  cap?: string;
  /** Default timeout for `call()` when the caller doesn't override it. */
  defaultTimeoutMs?: number;
}

/** Identity fields needed to build an SDKClient - `PluginContext` minus the `sdk` field itself
 * (which *is* the SDKClient being constructed - can't require an instance of itself as input). */
export type PluginIdentity = Omit<PluginContext, 'sdk'>;

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

  constructor(
    private readonly context: PluginIdentity,
    options: SDKClientOptions = {},
  ) {
    this.cap = options.cap;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
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
    return invokeHost<T>({
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

    if (target && (target.includes(' ') || target.length > 32 || !/^[0-9a-fA-F-]+$/.test(target))) {
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
   * `tts`/`stt`/`getModels`/`calculateTokens` are NOT present on the real `ai` object - use
   * `call('ai.tts', ...)` etc. directly if you need them; their exact param shape is unconfirmed.
   */
  readonly ai = {
    prompt: (quest: string | any[], opts?: LLMPromptOptions): Promise<any> =>
      this.call('ai.prompt', { quest, opts }),
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
  };

  /**
   * Only `search` is confirmed against the real `get knowledge()` in `src/base/SDK.ts`.
   * `store`/`get`/`del`/`reinforce` (from CodeSDK.d.ts) have no confirmed real implementation -
   * removed rather than risk a wrong param shape; use `call('knowledge.storeKnowledge', ...)` etc.
   * directly if you need them.
   */
  readonly knowledge = {
    search: (
      query: string,
      opts?: { workspace_id?: string; limit?: number; threshold?: number },
    ): Promise<any[]> => this.call('knowledge.searchKnowledge', { query, ...opts }),
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
  };

  readonly attachment = {
    search: (params: { query: string; limit?: number }): Promise<any[]> =>
      this.call('attachment.search', params),
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
  };

  readonly browser = {
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
   */
  readonly datastore = {
    ensureTable: (params: {
      purpose: string;
      workspace_id?: string;
      project_id?: string;
      target_columns?: string[];
    }): Promise<any> => this.call('datastore.ensureTable', params),
    createTable: (params: {
      workspace_id: string;
      project_id: string;
      name: string;
      description?: string;
      columns: any[];
      primary_id?: string;
      primary_key_column?: string;
    }): Promise<any> => this.call('datastore.createTable', params),
    getTables: (params: { workspace_id: string; project_id: string }): Promise<any[]> =>
      this.call('datastore.getTables', params),
    getTable: (params: { workspace_id: string; table_id: string }): Promise<any> =>
      this.call('datastore.getTable', params),
    updateTable: (params: {
      workspace_id: string;
      table_id: string;
      name?: string;
      description?: string;
      columns?: any[];
      primary_id?: string;
      primary_key_column?: string;
    }): Promise<any> => this.call('datastore.updateTable', params),
    deleteTable: (params: { workspace_id: string; table_id: string }): Promise<any> =>
      this.call('datastore.deleteTable', params),
    addRow: (params: {
      workspace_id: string;
      project_id: string;
      table_id: string;
      data: Record<string, any>;
    }): Promise<any> => this.call('datastore.addRow', params),
    getRow: (rowId: string): Promise<any> => this.call('datastore.getRow', { id: rowId }),
    updateRow: (rowId: string, data: Record<string, any>): Promise<any> =>
      this.call('datastore.updateRow', { row_id: rowId, ...data }),
    deleteRow: (rowId: string): Promise<any> => this.call('datastore.deleteRow', { row_id: rowId }),
    getRows: (params: {
      workspace_id: string;
      project_id: string;
      table_id: string;
      filter?: Record<string, any>;
      sort?: Record<string, any>;
      page?: number;
      limit?: number;
    }): Promise<any[]> => this.call('datastore.getRows', params),
    batchUpdateRows: (params: {
      workspace_id: string;
      project_id: string;
      table_id: string;
      filter: Record<string, any>;
      update: Record<string, any>;
    }): Promise<any> => this.call('datastore.batchUpdateRows', params),
    batchDeleteRows: (ids: string[]): Promise<any> =>
      this.call('datastore.batchDeleteRows', { ids }),
    bulkAddRows: (params: {
      workspace_id: string;
      project_id: string;
      table_id: string;
      rows: Record<string, any>[];
    }): Promise<any> => this.call('datastore.bulkAddRows', params),
    smartQuery: (query: string): Promise<any> => this.call('datastore.smartQuery', { query }),
    batchUpdateByAI: (instruction: string): Promise<any> =>
      this.call('datastore.batchUpdateByAI', { instruction }),
    searchSemantic: (params: {
      query: string;
      table_id?: string;
      limit?: number;
    }): Promise<any[]> => this.call('datastore.searchSemantic', params),
  };

  /**
   * `update`/`getById`/`delete` fixed to send `task_id` (matching `src/base/SDK.ts`'s real
   * `get task()`) - they previously sent `id`, which the real `task.updateTask`/`getTaskById`/
   * `deleteTask` handlers don't read, so those calls were silently broken. `gen`/`addComment`/
   * `requestSupport` (from CodeSDK.d.ts) have no confirmed real implementation - removed.
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

  readonly automation = {
    createJob: (params: { name: string; schedule?: string; logic: string }): Promise<any> =>
      this.call('automation.createJob', params),
    updateJob: (params: {
      id: string;
      name?: string;
      schedule?: string;
      logic?: string;
      [key: string]: any;
    }): Promise<any> => this.call('automation.updateJob', params),
    getJobs: (params?: { workspace_id?: string; limit?: number }): Promise<any[]> =>
      this.call('automation.getJobs', params),
    deleteJob: (params: { id: string }): Promise<any> => this.call('automation.deleteJob', params),
    executeById: (id: string): Promise<any> => this.call('automation.executeById', { id }),
  };

  readonly resource = {
    upload: (params: {
      file: any;
      name?: string;
      mime?: string;
      is_public?: boolean;
      temp?: boolean;
    }): Promise<any> => this.call('resource.uploadFile', params),
    remove: (params: { url: string }): Promise<any> => this.call('resource.removeFile', params),
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
      this.call('store.set', {
        table_id: table,
        key,
        data,
        ttl_seconds: ttlSeconds,
        schema,
        strict: options?.strict,
      }),
    get: (table: string, key: string): Promise<any | null> =>
      this.call('store.get', { table_id: table, key }),
    del: (table: string, key: string): Promise<{ deleted: boolean }> =>
      this.call('store.delete', { table_id: table, key }),
    bulk: (
      table: string,
      rows: Array<{ key: string; data: Record<string, any>; ttlSeconds?: number }>,
      schema?: any,
    ): Promise<{ success: number; failed: number }> =>
      this.call('store.bulkSet', { table_id: table, rows, schema }),
    query: (
      table: string,
      filter?: Record<string, any>,
      sort?: Record<string, 1 | -1>,
      limit?: number,
      page?: number,
    ): Promise<any[]> => this.call('store.query', { table_id: table, filter, sort, limit, page }),
    count: (table: string, filter?: Record<string, any>): Promise<number> =>
      this.call('store.count', { table_id: table, filter }),
    search: (
      table: string,
      query: string,
      options?: { mode?: 'semantic' | 'keyword' | 'hybrid'; limit?: number; threshold?: number },
    ): Promise<Array<any & { _similarity: number }>> =>
      this.call('store.search', { table_id: table, query, ...options }),
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
      this.call('store.aggregate', {
        table_id: table,
        metrics,
        group_by: options?.groupBy,
        filter: options?.filter,
        sort: options?.sort,
        limit: options?.limit,
      }),
    cursor: (
      table: string,
      filter?: Record<string, any>,
      options?: { sort?: Record<string, 1 | -1>; limit?: number; after?: string },
    ): Promise<{ rows: any[]; next: string | null }> =>
      this.call('store.cursor', { table_id: table, filter, ...options }),
    /** Each operation gets a `table_id` alias of `table` added (matching `src/base/SDK.ts` exactly)
     * - the real handler reads `table_id`, so omitting it silently dropped every operation. */
    transaction: (
      operations: Array<
        | { op: 'set'; table: string; key: string; data: Record<string, any>; ttlSeconds?: number }
        | { op: 'del'; table: string; key: string }
      >,
    ): Promise<void> =>
      this.call('store.transaction', {
        operations: operations.map((op) => ({ ...op, table_id: op.table })),
      }),
    join: (params: {
      from: { table: string; filter?: Record<string, any> };
      to: { table: string; filter?: Record<string, any> };
      on: string;
      embed?: string;
      limit?: number;
      page?: number;
    }): Promise<any[]> =>
      this.call('store.join', {
        from_table: params.from.table,
        from_filter: params.from.filter,
        to_table: params.to.table,
        to_filter: params.to.filter,
        on: params.on,
        embed: params.embed,
        limit: params.limit,
        page: params.page,
      }),
    link: (
      sourceTable: string,
      sourceKey: string,
      targetTable: string,
      targetKey: string,
      linkType?: string,
      data?: Record<string, any>,
    ): Promise<any> =>
      this.call('store.link', {
        source_table: sourceTable,
        source_key: sourceKey,
        target_table: targetTable,
        target_key: targetKey,
        link_type: linkType,
        data,
      }),
    unlink: (
      sourceTable: string,
      sourceKey: string,
      targetTable: string,
      targetKey: string,
      linkType?: string,
    ): Promise<{ deleted: number }> =>
      this.call('store.unlink', {
        source_table: sourceTable,
        source_key: sourceKey,
        target_table: targetTable,
        target_key: targetKey,
        link_type: linkType,
      }),
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
      this.call('store.getLinks', {
        source_table: sourceTable,
        source_key: sourceKey,
        target_table: options?.targetTable,
        link_type: options?.type,
        reverse: options?.reverse,
        limit: options?.limit,
      }),
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
