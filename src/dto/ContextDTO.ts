/**
 * Context Data Transfer Objects
 * 
 * Tham khảo từ các DTO trong src/
 * Chứa các interface cần thiết cho Context management
 */

// Tham khảo từ src/user/dto/UserDTO.ts
export enum GenderType {
  MALE = "male",
  FEMALE = "female", 
  OTHER = "other"
}

export interface User {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  nickname: string;
  avatar?: string;
  auth_type: string;
  auth_provider: string;
  country?: string;
  city?: string;
  district?: string;
  ward?: string;
  lang?: string;
  gender?: GenderType;
  client: string;
  created_at?: Date;
  updated_at?: Date;
}

// Tham khảo từ src/workspace/dto/WorkspaceDTO.ts
export interface Member {
  user_id?: string;
  email: string;
  avatar?: string;
  name?: string;
  role: string;
  position?: string;
  experience?: string;
}

export interface WorkflowConfig {
  step_list: string[];
  workflow: {
    member_id: string;
    member_name: string;
    assigned_steps: string[];
  }[];
  description: string;
}

export interface Workspace {
  id: string;
  name: string;
  avatar?: string;
  client: string;
  members?: Member[];
  message?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface Project {
  id: string;
  workspace_id: string;
  client: string;
  name: string;
  members?: Member[];
  is_delete?: boolean;
  workflow?: WorkflowConfig;
  created_at?: Date;
  updated_at?: Date;
}

// Tham khảo từ src/message/dto/MessageDTO.ts
export interface MediaItem {
  id: string;
  url: string;
  mime: string;
  extension?: string;
  name?: string;
  size?: number;
}

export interface ServerAction {
  func: string;
  args: any;
  payload?: any;
  options?: any;
}

export interface ClientAction {
  text: string;
  type?: 'primary' | 'secondary' | 'outline';
  place?: 'inline' | 'pin';
  func: string;
  args?: any;
}

export interface Session {
  id: string;
  name?: string;
  is_activated?: boolean;
  client: string;
  user_id: string;
  agent_id: string;
  agent_name: string;
  agent_avatar: string;
  current_llm_id: string;
  current_thread: string;
  llm_threads: any;
  driver: string;
  suggest_actions?: boolean;
  workspace_id?: string;
  project_id?: string;
  prompt_options?: any;
  training_scope?: any;
  training_share_scope?: any;
  created_at?: Date;
  updated_at?: Date;
}

export interface Message {
  id: string;
  session_id: string;
  user_id: string;
  text: string;
  images?: MediaItem[];
  files?: MediaItem[];
  audio?: MediaItem;
  role?: 'assistant' | 'user' | 'system';
  prompt?: ServerAction;
  actions?: ClientAction[];
  timestamp?: number;
  reply_id?: string;
  meta?: any;
  created_at?: Date;
  updated_at?: Date;
}

// Tham khảo từ src/assistant/dto/AssistantDTO.ts
export interface Agent {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
  instructions?: string;
  model?: string;
  tools?: any[];
  user_id: string;
  workspace_id?: string;
  is_public?: boolean;
  created_at?: Date;
  updated_at?: Date;
}

// Tham khảo từ src/app.todo/model/TodoModel.ts
export interface HandlerHistory {
  member_id: string;
  member_name: string;
  member_nickname: string;
  member_avatar: string;
  step: string;
  assigned_date: Date;
}

export interface Task {
  id: string;
  order?: number;
  title: string;
  key?: string;
  description?: string;
  step?: string;
  handler_history?: HandlerHistory[];
  from_date?: Date;
  to_date?: Date;
  priority: 'high' | 'medium' | 'low';
  creator_id: string;
  assign_id?: string;
  project_id: string;
  workspace_id: string;
  created_date?: Date;
  handler_state: 'todo' | 'doing' | 'done' | 'reject';
  hard_score: number;        // 0-1 difficulty score
  workload: number;          // Default 1
  complexity: 'simple' | 'normal' | 'complex';
  created_at?: Date;
  updated_at?: Date;
}

export interface FileShare {
  id: string;
  name: string;
  url: string;
  mime_type: string;
  size: number;
  owner_id: string;
  workspace_id?: string;
  project_id?: string;
  is_public?: boolean;
  created_at?: Date;
  updated_at?: Date;
} 