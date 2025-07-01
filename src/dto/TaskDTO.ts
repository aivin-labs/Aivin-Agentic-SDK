/**
 * Task Data Transfer Objects
 */

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

export interface TaskRequest {
    id?: string;
    title?: string;
    description?: string;
    step?: string;
    workload?: number;
    complexity?: 'simple' | 'normal' | 'complex';
    hard_score?: number;
    priority?: 'high' | 'medium' | 'low';
    from_date?: string;
    to_date?: string;
    order?: number;
}
