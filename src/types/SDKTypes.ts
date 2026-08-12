/**
 * Data models mirrored from the backend's `src/plugins/sdk/CodeSDK.d.ts` - the authoritative
 * contract for what a plugin receives/can call. Kept in sync manually; if the backend's
 * CodeSDK.d.ts changes, update this file to match.
 */

export interface User {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  nickname?: string;
  phone?: string;
  lang?: string;
}

export interface Workspace {
  id: string;
  name: string;
  key: string;
  client: string;
  avatar?: string;
  creator_uid: string;
  lang?: string;
  members: Array<{
    user_id: string;
    name: string;
    email: string;
    role: 'owner' | 'admin' | 'member' | 'observer';
  }>;
}

export interface MessageSession {
  id: string;
  client: string;
  workspace_id: string;
  user_id: string;
  agent_id?: string;
  name?: string;
  message_count: number;
  thread_id: string;
  status?: 'idle' | 'processing' | 'completed';
}

export interface Task {
  id: string;
  title: string;
  content?: string;
  status: 'todo' | 'doing' | 'done' | 'backlog' | 'cancel';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  assignee_id?: string;
  workspace_id: string;
  due_date?: string;
}

export interface Agent {
  id: string;
  name: string;
  avatar?: string;
  role?: string;
  description?: string;
  status: 'active' | 'inactive';
}

/**
 * Verified against the backend's real `JobResponse` (`AutomationDTO.ts`) - the actual return shape
 * of `automation.createJob`/`.updateJob`/`.getJobs`, not inferred from request params.
 */
export interface AutomationJob {
  id: string;
  mission: string;
  prompt?: string;
  workflow?: string[];
  workspace_id: string;
  project_id?: string;
  user_id: string;
  agent_id: string;
  /** Automation scheduling trigger (schedule/interval/delay/manual/random_wakeup) - a different,
   *  unrelated concept from the plugin manifest's `TriggerType` (manual/schedule/event/webhook/
   *  api/chat/widget) despite sharing some member names. Left as `string` (matching the backend's
   *  own untyped `JobResponse.trigger_type`) to avoid a colliding export name with `TriggerType`
   *  from `PluginTypes.ts`. */
  trigger_type?: string;
  /** Natural-language schedule description (e.g. "mỗi 5 phút", "hàng ngày lúc 9h") - the backend
   *  parses this into a cron/interval internally; it is NOT a raw cron string itself. */
  schedule_condition?: string;
  schedule_config?: Record<string, any>;
  plugin_id?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'limit_exceeded' | 'infeasible' | 'paused';
  last_run?: string;
  last_success?: string;
  last_error?: string;
  next_run?: string;
  success_count?: number;
  consecutive_errors?: number;
  is_disabled?: boolean;
  disabled_reason?: string;
  created_date?: string;
}

/**
 * The `{ nodes, edges }` graph format the platform's Workflow Editor (WorkflowSkillEditor on the
 * FE) saves into a plugin manifest's `workflow_data` - the SAME shape `agent.runFlow` accepts so a
 * flow built visually can be exported/pasted into plugin code and run directly, no "Upgrade to
 * Plugin" step required. Loosely typed (`Record<string, any>` node/edge data) - the backend
 * (`WorkflowPluginService.buildStages`) owns the real schema and throws a clear error on a
 * malformed node/edge before anything runs.
 */
export interface WorkflowGraph {
  nodes: Array<{ id: string; type: string; data: Record<string, any> }>;
  edges: Array<{ id: string; source: string; target: string; sourceHandle?: string; targetHandle?: string }>;
}

/**
 * A single already-built flow step (the backend's internal `StagePlan` shape - CONDITION/ROUTER/
 * PARALLEL/RETRY/WAIT/LOOP/ACTION). Left as a loose structural type rather than mirroring every
 * per-type config (`router_config`/`parallel_config`/...): the backend validates/guards each at
 * runtime (an unrecognized or malformed stage is skipped with a warning, not a hard crash), and
 * hand-building one is an advanced/rare path compared to passing a `WorkflowGraph` exported from
 * the Workflow Editor.
 */
export interface FlowStage {
  id: string;
  type: 'action' | 'condition' | 'router' | 'parallel' | 'retry' | 'wait' | 'loop';
  name?: string;
  [key: string]: any;
}

/** Result of one executed step from `agent.runFlow` - mirrors the backend's real `FlowStepResult`. */
export interface FlowStepResult {
  stepIndex: number;
  action_intent: string;
  mission: string;
  result: { status: string; message?: string; data?: any; [key: string]: any };
}

/**
 * Explicit identity `agent.runFlow` runs the flow as - build one with `ContextBuilder(...)` rather
 * than a bare object literal. Nothing here is inferred from the flow's own live session:
 * `agent.runFlow`'s underlying `RuntimeContext` never carries the caller's live `runtime_context`
 * bag across the sandbox boundary (same boundary `PluginBridge.secureRuntimeContext` enforces
 * everywhere else), so every override needed must be stated here. Anything omitted falls back to
 * the calling invocation's own agent/workspace.
 */
export interface RunFlowContext {
  agent_id?: string;
  workspace_id?: string;
  /** Reuses an existing session/thread (flow runs as part of that live conversation) instead of
   *  spinning up a new, invisible one - same pattern the platform uses for agent-to-agent consults
   *  within one chat. */
  session_id?: string;
  project_id?: string;
  attachments?: any[];
}

export interface LLMPromptOptions {
  instructions?: string;
  schema?: Record<string, any>;
  rules?: string;
  style?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  reasoning?: 'disabled' | 'low' | 'medium' | 'high';
  websearch?: 'none' | 'low' | 'medium' | 'high';
}

/** Verified against the backend's real `MediaItem` (`src/base/dto/BaseDTO.ts`) - the shape
 *  `ai.ocr` expects for its `image` argument. Either `url` or `file` (base64 dataURL/Buffer) must
 *  actually resolve to real image bytes server-side; `id` is caller-chosen, not looked up. */
export interface MediaItem {
  id: string;
  url: string;
  mime?: string;
  extension?: string;
  name?: string;
  size?: number | string;
  file?: any;
}

/** `ai.image`/`ai.video`-only options - verified against the backend's real `MediaPromptOptions`
 *  (`src/ai/dto/MediaGenerationDTO.ts`). `max_cost_usd` is the one worth knowing about early: set
 *  it to force a downgrade to a cheaper tier (or throw) instead of silently spending more than
 *  expected - there is no other client-side cost guard for media generation. */
export interface MediaPromptOptions extends LLMPromptOptions {
  image_opts?: Record<string, any>;
  video_opts?: Record<string, any>;
  /** Skip semantic routing, pick a tier directly. Image: quality|balanced|fast|budget|text|vector|
   *  creative|cinematic. Video: quality|balanced|fast|budget|motion|cinematic|creative|character. */
  media_tier?: string;
  /** Preference among several models in the same tier. */
  media_preference?: 'quality' | 'price' | 'balanced';
  /** Max USD for this one request - over-estimate triggers auto-downgrade to a cheaper tier, or
   *  throws if no tier fits. */
  max_cost_usd?: number;
}

/** Verified against the backend's real `MediaGenerationResult` (`src/ai/dto/MediaGenerationDTO.ts`) -
 *  the return shape of `ai.image`/`ai.video`. Exactly one of `url`/`data` is populated depending on
 *  whether the result was uploaded to storage or returned inline as base64. */
export interface MediaGenerationResult {
  url?: string;
  data?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  file?: any;
  created?: number;
  provider?: string;
  model?: string;
}

/**
 * `agent.reply`-only options - a superset of `LLMPromptOptions`. `rich_content` has no meaning for
 * `ai.prompt`/`ai.promptStream` (those never touch chat rendering), which is why it lives here and
 * not on the shared `LLMPromptOptions` type.
 */
export interface AgentReplyOptions extends LLMPromptOptions {
  /**
   * Unlocks PASSIVE display rich components (table/chart/mermaid/media/cardview/webview/citation)
   * so the model knows the markup the chat UI renders them from - `instructions` text alone does
   * NOT teach it this syntax. Deliberately does NOT unlock selection/form/action: those need
   * `agent.hil()`'s suspend+routing plumbing to actually receive a response when clicked; enabling
   * them here would render a button that looks interactive but does nothing.
   */
  rich_content?: boolean;
}

/** Verified against the backend's real `ResourceMeta` (`src/base/FSIO.ts`) - the actual return
 *  shape of `resource.upload`, not previously typed at all (was `any`). */
export interface ResourceMeta {
  id: string;
  name?: string;
  size?: number | string;
  user_id?: string;
  mime?: string;
  extension?: string;
  url: string;
  is_public?: boolean;
  /** True = deleted automatically after a period of time (temp upload cleanup). */
  temp?: boolean;
  workspace_id?: string;
  created_date?: string;
  /** Expiry timestamp for a `temp: true` upload. */
  expire_at?: string;
}

export const PluginStatus = {
  SUCCESS: 'success',
  ERROR: 'error',
  FAIL: 'fail',
  WAITING: 'waiting',
  NEEDS_AUTH: 'needs_auth',
  HIL_TIMEOUT: 'hil_timeout',
} as const;
export type PluginStatusType = (typeof PluginStatus)[keyof typeof PluginStatus];

export const PluginErrorCode = {
  INVALID_INPUT: 'INVALID_INPUT',
  MISSING_FIELD: 'MISSING_FIELD',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  HIL_PENDING: 'HIL_PENDING',
  HIL_REJECTED: 'HIL_REJECTED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  PARTIAL_SUCCESS: 'PARTIAL_SUCCESS',
} as const;
export type PluginErrorCodeType = (typeof PluginErrorCode)[keyof typeof PluginErrorCode];

export interface PluginResponse {
  status: PluginStatusType;
  data?: any;
  message?: string;
  error_code?: PluginErrorCodeType;
  domain_error_code?: string;
  domain_error_detail?: Record<string, any>;
}

export interface ConnectionInfo {
  token: string;
  name?: string;
  provider: string;
  [key: string]: any;
}

/** The 2nd argument to `main(mission, input, ctx)` - your plugin's declared input fields. */
export type PluginInput = Record<string, any>;

/**
 * The 3rd argument to `main(mission, input, ctx)` - the runtime identity for this one invocation.
 * Mirrors the backend's `PluginContext` (`CodeSDK.d.ts`), plus `cert` for connected-account
 * credentials (present whenever `manifest.connection_id` is set).
 */
export interface PluginContext {
  sdk: import('../sdk/SDKClient').SDKClient;
  user?: User;
  workspace?: Workspace;
  session?: MessageSession;
  org_id?: string;
  client?: string;
  config?: Record<string, any>;
  cert?: ConnectionInfo;
  metadata?: Record<string, any>;
}
