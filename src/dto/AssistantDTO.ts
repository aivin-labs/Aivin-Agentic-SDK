import { GenderType } from './UserDTO';
import { Member } from './WorkspaceDTO';

/**
 * Assistant Data Transfer Objects
 */

export interface AITool {
  type: string;
  function?: any;
  [key: string]: any;
}

export interface AIMetaRequest {
  agent_id?: string;
  default_provider?: string;
  default_model?: string;
  tools?: AITool[];
  description?: string;
  instructions?: string;
  members?: Member;
}

export interface Agent {
  id: string;
  name: string;
  avatar?: string;
  nickname: string;
  email: string;
  gender?: GenderType;
  bio?: string;
  specialized?: string;
  is_ai: boolean;
  meta?: AIMetaRequest;
  is_published?: boolean;
  user_id: string;
  workspace_id?: string;
  created_at?: Date;
  updated_at?: Date;
}