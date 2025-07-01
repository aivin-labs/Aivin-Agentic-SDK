/**
 * Workspace Data Transfer Objects
 */

export interface Member {
  user_id?: string;
  email: string;
  avatar?: string;
  name?: string;
  role: string;
  position?: string;
  experience?: string;
}

export interface MembersRequest {
  purpose: string;
  limit?: number;
  role?: string;
  requirements?: string;
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
  members?: Member[];
  message?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface Project {
  id: string;
  workspace_id: string;
  name: string;
  members?: Member[];
  is_delete?: boolean;
  workflow?: WorkflowConfig;
  created_at?: Date;
  updated_at?: Date;
} 