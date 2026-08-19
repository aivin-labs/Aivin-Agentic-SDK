/**
 * Data models mirrored from the backend's own plugin-contract type declaration - the authoritative
 * contract for what a plugin receives/can call. Kept in sync manually; if the backend's contract
 * changes, update this file to match.
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
 * Verified against the backend's real return shape of `automation.createJob`/`.updateJob`/
 * `.getJobs`, not inferred from request params.
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
 * bag across the sandbox boundary (the same boundary enforced everywhere else), so every override
 * needed must be stated here. Anything omitted falls back to the calling invocation's own
 * agent/workspace.
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

/**
 * One live progress event from `runFlow`/`promptAgentic`/`promptAction`/`promptAssistant`/`prompt`'s
 * `onEvent` callback - mirrors the backend's internal `clientLog(...)` log line shape exactly (the
 * SAME event the platform's own chat UI renders as a live log line), delivered over the same gRPC
 * server-streaming RPC `ai.promptStream` uses. `event_key` is the raw, unresolved i18n key (e.g.
 * `"flow.step_progress"`, `"agent.tool_complete"`) if you want to branch on it programmatically
 * instead of parsing `message`'s human-readable (and locale-dependent) text.
 */
export interface ClientLogEvent {
  id: string;
  session_id: string;
  thread_id: string;
  channel: string;
  message: string;
  status: 'process' | 'success' | 'error' | 'debug';
  timestamp: number;
  event_key?: string;
  meta?: Record<string, any>;
}

export interface LLMPromptOptions {
  /** Task-specific persona/role guidance - the one instruction field most callers want. Assembled
   *  into the system prompt AFTER `base_instruction`/`format_instruction`/`schema`'s auto-generated
   *  format text, BEFORE `rules`/`style`. Part of the "stable" half of the system prompt (same text
   *  across turns of the same workflow/agent) - see `dynamic_instruction` below for the per-turn
   *  half. Verified against the backend's real behavior. */
  instructions?: string;
  /** Most-static platform/system-level rules - assembled FIRST in the system prompt, ahead of
   *  `instructions`. Rarely needed from plugin code (this is normally where the PLATFORM's own
   *  baseline system prompt lives, not a per-call concern) - reach for `instructions` unless you
   *  specifically need to inject something ahead of it. Part of the "stable" half of the system
   *  prompt, same caching rationale as `instructions`. Verified against the backend's real
   *  behavior. */
  base_instruction?: string;
  /** RAG/context/history-derived guidance that changes every turn - kept as a SEPARATE block from
   *  `instructions`/`base_instruction`/`rules`/`style` (the "stable" half) specifically so a driver
   *  with explicit prompt-caching (Anthropic `cache_control`) can mark only the stable half
   *  cacheable, instead of a single per-turn-changing field invalidating the cache for everything
   *  joined alongside it. Providers with automatic prefix caching (OpenAI, Gemini) don't need this
   *  split - the host still joins both halves for them either way, so setting this is harmless (just
   *  pointless) there. Verified against the backend's real behavior. */
  dynamic_instruction?: string;
  /** Explicit override for the general output-FORMAT requirement text (e.g. "respond in valid
   *  JSON") - assembled right after `base_instruction`, before `schema`'s own auto-generated format
   *  text. Setting this SKIPS the host's own auto-generated format text entirely (whether from
   *  `schema` or from `response_format`) - normally not needed, since `schema` already generates its
   *  own accurate format instruction; reach for this only when you need to say something the
   *  auto-generated text doesn't cover. Verified against the backend's real behavior. */
  format_instruction?: any;
  /** Forces structured/JSON output matching this shape - NOT a raw JSON Schema object, the
   *  platform's own Custom Schema DSL: a plain object whose leaf values are `"type - description"`
   *  strings (e.g. `{ title: 'string - short title', priority: 'enum - enum: low, medium, high' }`).
   *  The host converts this to real JSON Schema for the model AND re-validates the response against
   *  it afterward, giving the model one self-heal retry on a field that comes back the wrong shape.
   *  Append `?` to the TYPE, not the key, to mark a field optional - `'string? - ...'`, not
   *  `'field?': '...'` (a trailing `?` on the key is a narrower, validation-layer-only convention -
   *  the JSON Schema builder that talks to the model does not strip it, so it would leak into the
   *  model-facing schema as a literal `"field?"` property name). Nest a plain object for a nested
   *  object, or a single-element array (`['string - ...']` / `[{ ... }]`) for a list - arbitrarily
   *  deep. See [Structured output with `schema`](../docs/sdk/ai.md#structured-output-with-schema)
   *  for the full type list (incl. `enum`/`any` and format-only types like `email`/`uuid`/`date`).
   *  Verified against the backend's real behavior. */
  schema?: Record<string, any>;
  /** Only meaningful when `ai.prompt()` is given a `listener` (3rd param) - declares the expected
   *  shape of EACH line as the response streams in, separate from `schema` above (which validates
   *  the final aggregated response, once complete). Setting this makes `listener.onParsedLine` (or
   *  `promptStream()`'s `lines` iterable) start yielding matched `ParsedLine`s as they arrive - see
   *  `ParsedLine`'s doc comment for the two accepted shapes (a single template string, or a
   *  keyword->template map for multiple line forms). The model is NOT forced to comply the way
   *  `schema` forces the final response - mention the expected line format in `instructions`
   *  yourself if you need the model to reliably follow it. Verified against the backend's real
   *  behavior. */
  lineSchema?: LineSchema;
  rules?: string;
  style?: string;
  /** Persona the model should adopt for this call - assembled as `Embody the persona of: {role}` in
   *  the system prompt, right after `instructions`. A plain hint string (`'expert'`, `'ai_staff'`,
   *  ...), not an enforced enum. Verified against the backend's real behavior. */
  role?: string;
  /** Freeform extra context injected for the model - unlike `instructions` (system-prompt guidance
   *  about HOW to respond), this is treated as background DATA the model can draw on. Verified
   *  against the backend's real behavior. */
  context?: any;
  /** Prior conversation turns for multi-turn context - shape is provider-dependent (not validated by
   *  this SDK), matches whatever the backend's chat-history format expects. Verified against the
   *  backend's real behavior. */
  history?: any[];
  /** Reference material/source text to ground the response in. Verified against the backend's real
   *  behavior. */
  reference?: string;
  /** Prefer this over `model` for normal use - lets the host pick the actual model, with live
   *  availability/fallback the way `model` never gets. `xhard` > `hard` > `medium` (all
   *  reasoning-capable) > `light` > `nano` (cheapest/fastest, reasoning off by default) by
   *  cost/capability, plus `code` (code-specialized) and `vl` (vision-capable) as separate tracks.
   *  The host resolves a tier to a live (provider, model) pair, cascading to a cheaper neighboring
   *  tier if every candidate in the requested one is offline, and can also auto-upgrade to a pricier
   *  neighbor if the requested tier itself is down (org still gets billed accordingly - a one-time
   *  toast warns the caller-side user when that happens). Omit both `tier` and `model` and the host
   *  defaults to `light`. Verified against the backend's real behavior. */
  tier?: 'xhard' | 'hard' | 'medium' | 'light' | 'nano' | 'code' | 'vl';
  /** Only meaningful alongside `tier` - caps which models in that tier are eligible by price
   *  (0-5, mapped to each model's configured `price_rate`; lower = cheaper). Omit to let the tier's
   *  own declared candidate order decide. Verified against the backend's real behavior. */
  quality?: number;
  /** Processing priority relative to other in-flight requests - doesn't change which model gets
   *  picked, only queuing order under load. Verified against the backend's real behavior. */
  priority?: 'high' | 'normal' | 'low';
  /** Pins one exact model, bypassing `tier`'s live-availability resolution and fallback cascade
   *  entirely - if this specific model is offline, the call fails instead of routing around it (there
   *  is no equivalent of `tier`'s auto-upgrade/downgrade for an explicit `model`). Reach for `tier`
   *  instead unless you have a real reason to pin one model (e.g. a capability only that model has).
   *  Omit to let `tier` (or the `light` default, if `tier` is also omitted) decide. Verified against
   *  the backend's real behavior. */
  model?: string;
  temperature?: number;
  max_tokens?: number;
  reasoning?: 'disabled' | 'low' | 'medium' | 'high';
  websearch?: 'none' | 'low' | 'medium' | 'high';
  /** Images to attach for a vision-capable model (`tier: 'vl'`, or any model that supports image
   *  input). Verified against the backend's real behavior. */
  images?: MediaItem[];
  /** Files to attach - support depends on the resolved model/provider. Verified against the
   *  backend's real behavior. */
  files?: MediaItem[];
  /** Audio input, for a model/route that accepts it directly (distinct from the separate `ai.stt`
   *  call). Verified against the backend's real behavior. */
  audio?: MediaItem;
  /** Video input, for a model/route that accepts it directly. Verified against the backend's real
   *  behavior. */
  video?: MediaItem;
  /** Only meaningful when `model` is set explicitly (no `tier`) - a call like that normally still
   *  gets ONE safety-net exception: an infra-level error (offline/5xx/tunnel down) auto-retries on a
   *  fallback model anyway, even though a plain bad-response error wouldn't. Set `true` to remove
   *  that exception too, so ANY error on the pinned model surfaces immediately. Has no effect when
   *  `tier` resolved the model instead of an explicit `model` - that path always retries the next
   *  candidate on error regardless of this flag. Verified against the backend's real behavior. */
  no_fallback?: boolean;
  /** Only meaningful when `model` is set explicitly (no `tier`) - forces the SAME auto-retry-on-error
   *  behavior a `tier`-resolved call gets for free, for a call that would otherwise be treated as
   *  strictly pinned to that one exact model (normally, an explicit `model` only falls back on an
   *  infra-level error, never on an ordinary bad-response error - see `no_fallback` above). This is a
   *  SEQUENTIAL retry (try the next candidate only after the current one errors), not a parallel race
   *  across candidates - there is no such parallel-request mechanism in `ai.prompt()`. Verified
   *  against the backend's real behavior. */
  allow_fallback?: boolean;
  /** Abort this call early - currently wired for `ai.prompt()`/`ai.promptStream()` only (NOT yet
   *  `getEmbedding`/`getEmbeddings`, despite sharing this same options type). Aborting cancels the
   *  underlying gRPC call, which the host observes and uses to actually stop generation server-side
   *  (not just "the client stops listening" while the model keeps running/being billed regardless).
   *  Local-only: stripped before `opts` is sent over the wire (an `AbortSignal` has no meaningful
   *  JSON form, and the host doesn't need it - it derives its OWN cancellation signal from the gRPC
   *  call itself being cancelled).
   *  ```ts
   *  const controller = new AbortController();
   *  setTimeout(() => controller.abort(), 5000); // give up after 5s
   *  await ai.prompt(quest, { signal: controller.signal });
   *  ```
   */
  signal?: AbortSignal;
  /**
   * Your own id for this specific call - set it if you might need to cancel this call FROM
   * SOMEWHERE ELSE later (a different invocation, a webhook, a "Stop" button handled by a separate
   * request than the one that started generating). `signal` above only works within the same
   * invocation that's still holding the `AbortController` in scope; `ai.cancel(id)` works across
   * invocations/processes - see its own doc comment. Omit if you don't need this - `signal` alone
   * covers the (more common) same-invocation case, no id required.
   * ```ts
   * const id = crypto.randomUUID();
   * await ai.prompt(quest, { request_id: id }, listener); // started here...
   * // ...cancelled from a completely different invocation later:
   * await ai.cancel(id);
   * ```
   * Sent to the host as `unique_request_id` (a pre-existing tracking/audit id on the backend, not
   * something introduced for cancellation) - renamed here only because that's a mouthful for
   * something you'll type at every cancellable call site; translated on the way out.
   */
  request_id?: string;
}

/**
 * One line-matching template, e.g. `"[source:string - step id nguồn] -> [target:string - step id đích]"`.
 * Syntax: `[fieldName:type - description]` for a field; everything else in the string is literal
 * text (whitespace around it matches flexibly). The description after `-` is never enforced, only
 * ever used as a hint if you paste this template into `instructions` yourself. Verified against
 * the backend's real behavior.
 */
export type LineTemplate = string;

/**
 * Declares what each streamed line should look like. No new syntax to learn beyond what `schema`
 * (structured output) and `LineTemplate` (above) already cover - every value in here is one of
 * exactly those two:
 * - A bracket `LineTemplate` (`"[field:type - desc]"`) - the line is REGEX-matched against it
 *   positionally; `ParsedLine.fields` comes back all-string (raw regex captures).
 * - The same `"type - description"` string `schema` uses (no brackets) - the line is `JSON.parse`d
 *   instead and checked against those field names; `ParsedLine.fields` comes back as whatever JSON
 *   parsed to (numbers/booleans/nested objects survive, not coerced to string).
 * Passing `lineSchema` itself takes one of two shapes:
 * - A single string - every line in the stream must match that ONE template/DSL, no leading keyword
 *   (`ParsedLine.form` comes back `''`).
 * - A `Record<string, string>` - classified by its VALUES, not a separate flag: if every value is a
 *   bracket `LineTemplate`, this is a map of MULTIPLE line forms, each key a literal keyword that
 *   must start the line (e.g. `{ NODE: "[id:string - ...]", EDGE: "[from:string - ...] -> ..." }`) -
 *   tried in declaration order, `ParsedLine.form` comes back as the matched keyword. Otherwise (no
 *   bracket syntax in any value), each line is parsed as one JSON object instead, `ParsedLine.form`
 *   comes back `'json'`.
 * Verified against the backend's real behavior.
 */
export type LineSchema = LineTemplate | Record<string, string>;

/**
 * Mirrors the backend's own listener interface - the shape `ai.prompt(quest, opts, listener)`'s 3rd
 * parameter takes. Only a SUBSET actually crosses the plugin<->host gRPC boundary today - the rest
 * are accepted for type/interface parity but never called:
 * - **Wired**: `onUpdate` (text deltas - `type` is always `'text'`), `onReasoning` (reasoning-model
 *   "thinking" text, separate stream from `onUpdate`), `onLine` (raw per-line text, unconditional -
 *   doesn't need `opts.lineSchema`), `onParsedLine` (only fires when `opts.lineSchema` is set),
 *   `onCompleted`, `onError`.
 * - **Not yet wired** (silently never called - don't rely on these): `onCreated`, `onResponse`,
 *   `interuptMessage` - these map to the platform's own chat-message persistence lifecycle
 *   (`agent.reply`/session flows), which a raw `ai.prompt()` call has no equivalent of.
 * `lineSchema` goes on `PromptOptions`/`opts` (2nd param), NOT on this listener - matches the
 * backend's own real read path (it reads `opts.lineSchema`, not `listener.lineSchema`, even though
 * the backend's own listener type also happens to declare the field).
 * Every wired callback may return `void` or `Promise<void>` - returning a Promise gives you REAL
 * backpressure (`prompt()`'s internal drain loops `await` it before pulling the next chunk/line),
 * same mechanism `prompt(quest, opts, aWritable)`'s own `onUpdate` uses internally to respect a
 * `Writable`'s `'drain'` event. A plain synchronous (`void`-returning) callback still works exactly
 * as before - awaiting an already-resolved value is a no-op.
 */
export interface MessageListener {
  interuptMessage?: boolean;
  onCreated?: () => void;
  onUpdate?: (chunk: string, type?: string) => void | Promise<void>;
  onResponse?: (res: any, type?: string) => any;
  onCompleted?: () => void | Promise<void>;
  onError?: (err: any) => void | Promise<void>;
  onReasoning?: (reasoning: string) => void | Promise<void>;
  onLine?: (line: string) => void | Promise<void>;
  onParsedLine?: (parsed: ParsedLine | null, index: number) => void | Promise<void>;
}

/** One line of `prompt()`'s streaming `onParsedLine` (or `promptStream()`'s `lines` iterable),
 *  already matched against `opts.lineSchema`.
 *  `form` is the matched keyword (for a multi-form object `LineSchema`), `'json'` (for the JSON-line
 *  form), or `''` (for a single-template string `LineSchema` - there's no keyword to report).
 *  `fields` holds the captured/parsed field values, keyed by the field names declared in
 *  `lineSchema` - same value types `schema`'s DSL produces, PLUS plain `string` (raw regex capture)
 *  for a row that matched a bracket `LineTemplate` instead of the JSON-line form (hence `any` here,
 *  not `string`). Lines that don't match anything in `lineSchema` are silently skipped - they never
 *  appear in `lines` (read `textStream` yourself, unparsed, if you need those too). Verified against
 *  the backend's real behavior. */
export interface ParsedLine {
  form: string;
  fields: Record<string, any>;
}

/** Verified against the backend's real behavior - the shape `ai.ocr` expects for its `image`
 *  argument. Either `url` or `file` (base64 dataURL/Buffer) must actually resolve to real image
 *  bytes server-side; `id` is caller-chosen, not looked up. */
export interface MediaItem {
  id: string;
  url: string;
  mime?: string;
  extension?: string;
  name?: string;
  size?: number | string;
  file?: any;
}

/** `ai.image`/`ai.video`-only options - verified against the backend's real behavior.
 *  `max_cost_usd` is the one worth knowing about early: set it to force a downgrade to a cheaper
 *  tier (or throw) instead of silently spending more than expected - there is no other client-side
 *  cost guard for media generation. */
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

/** Verified against the backend's real behavior - the return shape of `ai.image`/`ai.video`.
 *  Exactly one of `url`/`data` is populated depending on whether the result was uploaded to storage
 *  or returned inline as base64. */
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

/** Verified against the backend's real behavior - the actual return shape of `resource.upload`,
 *  not previously typed at all (was `any`). */
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
 * Mirrors the backend's own `PluginContext`, plus `cert` for connected-account credentials
 * (present whenever `manifest.connection_id` is set).
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
