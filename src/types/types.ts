// Core types
export interface AutomationConfig {
    baseUrl: string;
    apiKey?: string;
    workspaceId: string;
    userId?: string;
    timeout?: number;
    retries?: number;
    debug?: boolean;
}

// Job and Flow types
export interface JobEntity {
    job_id: string;
    flow_id: string;
    plugin_id: string;
    plugin_function: string;
    input_data: any;
    output_data?: any;
    status: JobStatus;
    created_at: string;
    updated_at: string;
    started_at?: string;
    completed_at?: string;
    execution_time?: number;
    error_message?: string;
    retry_count: number;
    max_retries: number;
    trigger_type: TriggerType;
    priority: number;
    previous_job_id?: string;
    next_job_id?: string;
    workspace_id: string;
    user_id: string;
    metadata?: Record<string, any>;
}

export interface FlowEntity {
    flow_id: string;
    name: string;
    description?: string;
    jobs: string[];
    status: FlowStatus;
    created_at: string;
    updated_at: string;
    started_at?: string;
    completed_at?: string;
    trigger_type: TriggerType;
    target: string;
    workspace_id: string;
    user_id: string;
    current_index?: number;
    success_count?: number;
    failure_count?: number;
    metadata?: Record<string, any>;
}

// Status types
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type FlowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'active';
export type TriggerType = 'manual' | 'schedule' | 'event' | 'webhook' | 'api' | 'chat';

// Plugin types
export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    functions: PluginFunction[];
    trigger_type?: string[];
    capabilities?: string[];
    dependencies?: string[];
    config?: Record<string, any>;
}

export interface PluginFunction {
    id: string;
    name: string;
    description?: string;
    parameters: PluginParameter[];
    returns?: PluginReturn;
    trigger_type: string[];
}

export interface PluginParameter {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    required?: boolean;
    description?: string;
    default?: any;
    enum?: any[];
}

export interface PluginReturn {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    description?: string;
    schema?: Record<string, any>;
}

export interface PluginExecutionResult {
    success: boolean;
    data?: any;
    error?: string;
    executionTime?: number;
    metadata?: Record<string, any>;
}

// API Response types
export interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    error?: string;
    message?: string;
    metadata?: Record<string, any>;
}

export interface ExecutionResponse {
    success: boolean;
    flow_id: string;
    jobs_count: number;
    message: string;
}

export interface PluginListResponse {
    plugins: PluginManifest[];
    count: number;
}

// Socket event types
export interface SocketEventData {
    job_id?: string;
    flow_id?: string;
    workspace_id: string;
    status: JobStatus | FlowStatus;
    data?: any;
    error?: string;
    completed_jobs?: number;
    total_jobs?: number;
    timestamp: string;
}

// Error types
export class AutomationError extends Error {
    public code: string;
    public statusCode?: number;
    public details?: any;

    constructor(message: string, code: string, statusCode?: number, details?: any) {
        super(message);
        this.name = 'AutomationError';
        this.code = code;
        this.statusCode = statusCode;
        this.details = details;
    }
}

// Utility types
export type EventHandler<T = any> = (data: T) => void;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'; 