# 📊 Aivin SDK — Data Structures

Every type below is exported from `@aivin-labs/sdk` and mirrors the backend's real data models
(`src/plugins/sdk/CodeSDK.d.ts`).

```typescript
// Type-only imports - erased at build time, just for editor/type-checking:
import type {
  User,
  Workspace,
  Task,
  Agent,
  PluginManifest,
  PluginInput,
  PluginContext,
  PluginResponse,
} from '@aivin-labs/sdk';

// Real (value) imports - these exist at runtime, use them in your return statements:
import { PluginStatus, PluginErrorCode } from '@aivin-labs/sdk';
```

## Context types

### `User`

```typescript
interface User {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  nickname?: string;
  phone?: string;
  lang?: string;
}
```

### `Workspace`

```typescript
interface Workspace {
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
```

### `MessageSession`

```typescript
interface MessageSession {
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
```

### `Task`

```typescript
interface Task {
  id: string;
  title: string;
  content?: string;
  status: 'todo' | 'doing' | 'done' | 'backlog' | 'cancel';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  assignee_id?: string;
  workspace_id: string;
  due_date?: string;
}
```

### `Agent`

```typescript
interface Agent {
  id: string;
  name: string;
  avatar?: string;
  role?: string;
  description?: string;
  status: 'active' | 'inactive';
}
```

### `ConnectionInfo` (available as `ctx.cert` when `manifest.connection_id` is set)

```typescript
interface ConnectionInfo {
  token: string; // access token / API key for the connected external service
  name?: string; // connected account name/email
  provider: string; // e.g. "google", "slack", "github"
  [key: string]: any;
}
```

## LLM types

### `LLMPromptOptions`

```typescript
interface LLMPromptOptions {
  instructions?: string;
  schema?: Record<string, any>; // force structured JSON output
  rules?: string;
  style?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  reasoning?: 'disabled' | 'low' | 'medium' | 'high';
  websearch?: 'none' | 'low' | 'medium' | 'high';
}
```

## Plugin response

### `PluginResponse`

What your `main()` return value should generally look like — not strictly enforced, but this is
what downstream tooling (agentic planner, UI) expects.

```typescript
interface PluginResponse {
  status: PluginStatusType; // see PluginStatus below
  data?: any;
  message?: string;
  error_code?: PluginErrorCodeType; // see PluginErrorCode below
  domain_error_code?: string; // your own business error code
  domain_error_detail?: Record<string, any>;
}
```

`status` is what the platform actually reads (`PluginExecutionService` checks `response.status !==
PluginStatus.FAIL && response.status !== PluginStatus.ERROR` to decide success) - there's no
special handling for a `success: boolean` field. Omitting `status` entirely still works (anything
without an explicit `fail`/`error` status is treated as successful), but that's a fail-open default,
not a documented alternative - always return `status` explicitly.

### `PluginStatus`

```typescript
const PluginStatus = {
  SUCCESS: 'success',
  ERROR: 'error',
  FAIL: 'fail',
  WAITING: 'waiting',
  NEEDS_AUTH: 'needs_auth',
  HIL_TIMEOUT: 'hil_timeout',
};
```

### `PluginErrorCode`

```typescript
const PluginErrorCode = {
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
};
```

## Manifest types

### `PluginManifest`

The shape of `manifest.json`. Full field-by-field description: [MANIFEST.md](./MANIFEST.md).

```typescript
interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  email?: string;
  /** Multi-function manifests only - see MANIFEST.md#multi-function-plugins. */
  func?: string;
  input: object;
  output?: string | object;
  instructions?: string;
  capabilities?: string[];
  selection_rules?: string[];
  initable?: string[];
  depend_on?: string | PluginDependency | (string | PluginDependency)[];
  mapping_reasoning?: boolean | string[];
  connection_id?: string;
  timeout_ms?: number;
  circuit_breaker?: { fail_threshold?: number; window_sec?: number; cooldown_sec?: number };
  expose?: string[];
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
  request_hil?: boolean;
  hard_confirm?: boolean;
  /** Proxy into an external system (MCP, REST, n8n, ...) instead of running custom code. */
  proxy_config?: object;
}

interface PluginDependency {
  plugin: string;
  optional?: boolean;
  condition?: string;
  fallback_field?: string;
}
```

### `TriggerType`

```typescript
const TriggerType = {
  MANUAL: 'manual',
  SCHEDULE: 'schedule',
  EVENT: 'event',
  WEBHOOK: 'webhook',
  API: 'api',
  CHAT: 'chat',
};
```

## `main()`'s parameters

```typescript
function main(mission: string, input: PluginInput, ctx: PluginContext): Promise<PluginResponse>;
```

- `mission: string` — human-readable reason this run was triggered (logging only, not routing).
- `input: PluginInput` — `Record<string, any>`, shaped per `manifest.json`'s `input` description.
- `ctx: PluginContext`:

```typescript
interface PluginContext {
  sdk: SDKClient; // see docs/SDK.md — or `import SDK from '@aivin-labs/sdk'`
  user?: User;
  workspace?: Workspace;
  session?: MessageSession;
  org_id?: string;
  client?: string;
  config?: Record<string, any>;
  cert?: ConnectionInfo; // connected-account credentials, if manifest.connection_id is set
}
```
