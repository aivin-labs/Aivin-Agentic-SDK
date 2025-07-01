/**
 * FileShare Data Transfer Objects
 */

export interface FileShare {
  id: string;
  workspace_id: string;
  project_id?: string;
  name: string;
  content: string;
  extension?: string;
  creator_id: string;
  created_date: Date;
  last_updated: Date;
  is_public: boolean;
  shared_with: string[];
  checksum?: string;
} 