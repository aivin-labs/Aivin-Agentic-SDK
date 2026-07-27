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
