/**
 * Message Data Transfer Objects
 */

import { PromptOptions } from "./LLMDTO";

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
  prompt_options?: PromptOptions;
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

export interface MessageRequest {
  id?: string;
  session_id: string;
  user_id: string;
  text?: string;
  images?: MediaItem[];
  files?: MediaItem[];
  audio?: MediaItem;
  meta?: any;
  prompt?: ServerAction;
  schema?: any;
  role?: "user" | "assistant" | "system";
  interrupt?: boolean;
} 