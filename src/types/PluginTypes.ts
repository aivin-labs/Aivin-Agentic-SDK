/**
 * Plugin manifest type definitions.
 *
 * Mirrored from the backend's `DeveloperPluginManifest`/`PluginManifest`
 * (`src/plugins/dto/PluginDTO.ts`) - only the fields a plugin author actually
 * sets in `manifest.json` are included here. Fields the platform assigns
 * itself (`id`, `is_verified`, `is_official`, `client`, `store_status`,
 * `verification_status`, `network_config`, `checksum`, `rate_limit`, ...)
 * are intentionally omitted; they exist server-side only.
 */
export interface PluginManifest {
  /** Auto-generated when the plugin is created; do not set by hand. */
  id: string;
  /** Unique identifier, lowercase-hyphen (e.g. "text-summarizer"). */
  name: string;
  description: string;
  version?: string;
  author?: string;
  email?: string;
  /**
   * URL to an image representing this plugin (shown in plugin listings/pickers) - a plain string
   * field on the real backend schema (`PluginModel.ts`'s `avatar`), not previously typed here.
   * Omit it and the platform falls back to the publishing user's own avatar. Host the image
   * yourself first (e.g. `resource.upload({ file, is_public: true })` - see docs/sdk/resource.md -
   * or any public URL) and put the resulting URL here; this field does not accept raw image bytes.
   */
  avatar?: string;
  /**
   * Name of the exported function in `src/main.ts` this manifest calls. Only meaningful for a
   * multi-function plugin, where several manifest entries (see `MultiFunctionManifestEntry`) share
   * one uploaded `src/main.ts`/container - omit it for a normal single-function plugin, which
   * always resolves `main`/the default export instead.
   */
  func?: string;

  /** Free-form description of what the handler expects/returns (not a strict JSON schema). */
  input: object;
  output?: string | object;

  /** Extra guidance for the AI planner on how/when to use this plugin. */
  instructions?: string;
  capabilities?: string[];
  /**
   * Explicit natural-language rules for when the planner should pick this plugin, e.g.
   * `["Requests for high-fidelity deep research across multiple sources", "Standard web search
   * results are insufficient or overly superficial"]`. This is the single strongest discovery
   * signal - shown directly to the planner as `Rules: ...` right next to `description` when it's
   * choosing between candidate plugins, weighted above `capabilities`/`instructions`. Write it as
   * the concrete triggering conditions for this plugin, not a restatement of what it does.
   */
  selection_rules?: string[];
  /** Fields the plugin needs configured once per workspace before it can run. */
  initable?: string[];
  depend_on?: string | PluginDependency | (string | PluginDependency)[];
  /**
   * Controls how the planner maps its own output onto `input`'s fields before calling this
   * plugin: `true` - every field is resolved through LLM reasoning (slower, more flexible);
   * `string[]` - only the named fields go through reasoning, the rest are mapped directly by key
   * (faster); omitted - all fields mapped directly by key.
   */
  mapping_reasoning?: boolean | string[];

  /** Namespace for a shared connection - plugins with the same connection_id share credentials. */
  connection_id?: string;
  /** Execution timeout in ms (host also caps this - see PluginRunner.MAX_DOCKER_TIMEOUT_MS). */
  timeout_ms?: number;
  /** Per-plugin override of the platform's default circuit breaker (opens after repeated
   *  failures to stop retrying a broken plugin). Omitted = system default thresholds. */
  circuit_breaker?: {
    /** Consecutive failures before the circuit trips (default: 3). */
    fail_threshold?: number;
    /** Rolling window for counting failures, in seconds (default: 300). */
    window_sec?: number;
    /** Cooldown before the circuit allows a retry, in seconds (default: 60). */
    cooldown_sec?: number;
  };

  /** Field paths from this plugin's data exposed externally (dynamic API / selection context). */
  expose?: string[];
  /**
   * Dedicated service containers (`"REDIS_CACHE"`, `"MONGODB"`, `"BACKGROUND_JOBS"`,
   * `"REALTIME_COMMUNICATION"`) provisioned alongside this plugin's own container, instead of the
   * shared, host-mediated `store`/`redis`/`mongo` namespaces. Only relevant for deployments that
   * don't use shared infrastructure (e.g. dedicated/on-premise); omit it for the normal case.
   */
  stacks?: string[];

  trigger_type?: TriggerType[];
  initial?: object;
  scope?: string[];
  category?: string;
  metadata?: Record<string, any>;
  license?: string;
  repository_url?: string;
  compute_factor?: number;
  side_effect?: boolean;
  requires_human?: boolean;
  /**
   * Marks this plugin as sensitive, requiring human-in-the-loop review before it runs. Usually
   * assigned automatically by the platform's own indexing/audit process rather than set by hand.
   */
  request_hil?: boolean;
  /**
   * "Action gate" - a hard flag only a human admin can set (never the LLM or an automated audit),
   * for actions with severe, hard-to-reverse consequences (bulk data deletion, financial
   * transactions, security config changes). Unlike `request_hil` (which an admin can let agents
   * bypass via their own autonomy settings), `hard_confirm` has no bypass and blocks completely on
   * automation/system-triggered channels - a human must be present to confirm.
   */
  hard_confirm?: boolean;

  /**
   * Declares this plugin as a proxy into an external system (an MCP server, a REST API, n8n,
   * ...) instead of running custom code. When set, no `src/main.ts`/`main()` is needed - the host
   * calls straight through based on this config, and `aivin deploy`/`aivin test` send the manifest
   * alone (no files). Only the `mcp` variant is meant to be authored through this SDK - see
   * `aivin mcp create` and docs/MANIFEST.md#mcp-proxy-plugins. The others (`rest`, `n8n-node`,
   * `coze`, `dify`, ...) are configured through the platform dashboard; they're typed here only so
   * a manifest read back from the server has an accurate shape.
   */
  proxy_config?: PluginProxyConfig;
}

/**
 * One entry of a multi-function plugin, after `flattenManifestFile()` expands the `plugins: [...]`
 * shape below - a full `PluginManifest` plus which named export in `src/main.ts` implements it.
 * Each entry is deployed/registered as its own independent plugin `id`, all backed by the same
 * `src/main.ts`/container. This is an in-memory shape only - `manifest.json` on disk is never a
 * bare array (see `MultiFunctionManifestGroup`).
 */
export interface MultiFunctionManifestEntry extends PluginManifest {
  /** Name of the exported function in `src/main.ts` that implements this entry, e.g.
   *  `export async function summarizeTicket(mission, input, ctx) { ... }` -> `"func": "summarizeTicket"`. */
  func: string;
}

/**
 * `manifest.json`'s authoring shape for a multi-function plugin: fields shared by every function
 * (`version`, `author`, `connection_id`, ...) live once at the top level instead of
 * being repeated in each `plugins[]` entry - `flattenManifestFile()` merges them back in before
 * this ever reaches deploy or runtime resolution. Entry-specific fields (`id`, `name`, `func`,
 * `input`, `output`, ...) win over a same-named common field if both are set. `manifest.json` is
 * always a single JSON object - either a plain `PluginManifest` (single-function) or this shape
 * (multi-function); it is never a bare top-level array.
 */
export interface MultiFunctionManifestGroup {
  plugins: Array<Partial<MultiFunctionManifestEntry> & { id: string; func: string }>;
  [commonField: string]: unknown;
}

/**
 * Normalizes whatever shape `manifest.json` was authored in into what deploy/runtime actually
 * understand: a single `PluginManifest`, or a flat `MultiFunctionManifestEntry[]` (only ever
 * produced in-memory, by expanding a `{ ...commonFields, plugins: [...] }` file). Passes a plain
 * object through unchanged (including one with some other unrelated field - only a `plugins` array
 * specifically triggers the merge). A bare top-level array is not a supported `manifest.json` shape
 * - author a multi-function plugin as `{ ...commonFields, plugins: [...] }` instead.
 */
export function flattenManifestFile(
  raw: unknown,
): PluginManifest | MultiFunctionManifestEntry[] {
  if (Array.isArray(raw)) {
    throw new Error(
      'manifest.json cannot be a bare JSON array. For a multi-function plugin, use ' +
        '{ ...commonFields, plugins: [...] } instead - see docs/MANIFEST.md#multi-function-plugins.',
    );
  }
  if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { plugins?: unknown }).plugins)
  ) {
    const { plugins, ...common } = raw as MultiFunctionManifestGroup;
    if (plugins.length === 0) {
      throw new Error(
        'manifest.json\'s "plugins" array is empty - a multi-function plugin needs at least one entry.',
      );
    }
    const flattened = plugins.map((entry) => ({ ...common, ...entry })) as MultiFunctionManifestEntry[];
    flattened.forEach((entry, i) => {
      const record = entry as unknown as Record<string, unknown>;
      const missing = ['id', 'name', 'func'].filter((field) => !record[field]);
      if (missing.length > 0) {
        throw new Error(
          `manifest.json's "plugins[${i}]" is missing required field(s): ${missing.join(', ')}.`,
        );
      }
    });
    return flattened;
  }
  return raw as PluginManifest;
}

/**
 * Plain object + union type instead of `enum` - see the note on `TriggerType` below for why.
 * Mirrors the backend's `PluginProxyType` (`src/plugins/dto/PluginDTO.ts`) exactly.
 */
export const PluginProxyType = {
  MCP: 'mcp',
  OPENAI: 'openai',
  CLAUDE: 'claude',
  N8N: 'n8n',
  N8N_NODE: 'n8n-node',
  REST: 'rest',
  API: 'api',
  ZAPIER: 'zapier',
  MAKE: 'make',
  COZE: 'coze',
  DIFY: 'dify',
  GRPC: 'grpc',
  LITE: 'lite',
  DOCKER: 'docker',
  WASM: 'wasm',
  PROMOTED_CODE: 'promoted_code',
  WORKFLOW: 'workflow',
} as const;
export type PluginProxyType = (typeof PluginProxyType)[keyof typeof PluginProxyType];

export const PluginAuthType = {
  NONE: 'none',
  BEARER: 'bearer',
  BASIC: 'basic',
  APIKEY: 'apikey',
} as const;
export type PluginAuthType = (typeof PluginAuthType)[keyof typeof PluginAuthType];

export const McpTransportType = {
  STDIO: 'stdio',
  SSE: 'sse',
} as const;
export type McpTransportType = (typeof McpTransportType)[keyof typeof McpTransportType];

/** Which MCP primitive this plugin represents - decides the JSON-RPC method the host calls
 *  (`tools/call`, `resources/read`, or `prompts/get`). Defaults to `tool` if omitted. */
export const McpPluginKind = {
  TOOL: 'tool',
  RESOURCE: 'resource',
  PROMPT: 'prompt',
} as const;
export type McpPluginKind = (typeof McpPluginKind)[keyof typeof McpPluginKind];

export interface BaseProxyConfig {
  type: PluginProxyType;
  url?: string;
  auth_type?: PluginAuthType;
  /** Name of a secret already stored in the workspace's credential store - never the raw secret
   *  value itself. */
  auth_secret_key?: string;
  authHeader?: string;
  authToken?: string;
  headers?: Record<string, string>;
}

export interface McpProxyConfig extends BaseProxyConfig {
  type: 'mcp';
  mcp_transport?: McpTransportType;
  mcp_server_id?: string;
  /** Command to launch the MCP server - only used when `mcp_transport` is `stdio`. */
  mcp_command?: string;
  mcp_args?: string[];
  /** Remote MCP server URL - only used when `mcp_transport` is `sse` (Streamable HTTP), instead
   *  of `mcp_command`/`mcp_args`. */
  mcp_url?: string;
  /** Name of the resolved env key (admin secret / workspace config / OAuth) to use as the Bearer
   *  token when calling the remote MCP server. Unset -> falls back to `MCP_BEARER_TOKEN`/`Authorization`. */
  mcp_auth_env_key?: string;
  mcp_kind?: McpPluginKind;
  /** Real tool name per the MCP protocol - only meaningful when `mcp_kind` is `tool`. */
  mcp_tool_name?: string;
  mcp_env?: Record<string, string>;
  /** Resource URI - only meaningful when `mcp_kind` is `resource`. */
  mcp_resource_uri?: string;
  mcp_resource_mime_type?: string;
  /** Prompt name per the MCP protocol - only meaningful when `mcp_kind` is `prompt`. */
  mcp_prompt_name?: string;
}

/** Every other proxy variant the platform supports server-side - configured through the
 *  dashboard/other integrations, not through this SDK. */
export interface GenericProxyConfig extends BaseProxyConfig {
  type: Exclude<PluginProxyType, 'mcp'>;
  [key: string]: any;
}

export type PluginProxyConfig = McpProxyConfig | GenericProxyConfig;

export interface PluginDependency {
  /** ID of the dependency plugin. */
  plugin: string;
  /** true = only call when needed (default: false = required - scheduled into an earlier
   *  execution stage, so it always runs, and its result is available, before this plugin does). */
  optional?: boolean;
  condition?: string;
  fallback_field?: string;
}

/**
 * Trigger Types
 *
 * Plain object + union type instead of `enum`: src/main.ts files are loaded at
 * runtime via native Node ESM (see PluginServer.loadPlugin), which only
 * supports erasable TS syntax. `enum` emits real JS and breaks that path.
 */
export const TriggerType = {
  MANUAL: 'manual',
  SCHEDULE: 'schedule',
  EVENT: 'event',
  WEBHOOK: 'webhook',
  API: 'api',
  CHAT: 'chat',
  /** Only visible to widget sessions - see `filterSelectablePlugins` on the backend, which hides
   *  any plugin declaring this trigger from every non-widget session. */
  WIDGET: 'widget',
} as const;

export type TriggerType = (typeof TriggerType)[keyof typeof TriggerType];
