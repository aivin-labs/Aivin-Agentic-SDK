/**
 * Plugin SDK Type Definitions
 * 
 * This file contains all type definitions for the Plugin SDK.
 * Can be extracted into a separate npm package later.
 */

export interface PluginExecutionData {
    job_id: string;
    flow_id: string;
    plugin_id: string;
    function_name: string;
    input: any;
    workspace_id: string;
    user_id: string;
    metadata?: any;
    timeout?: number;
}

export interface PluginExecutionResult {
    success: boolean;
    result?: any;
    error?: string;
    execution_time?: number;
    timestamp: string;
}

export interface PluginFunction {
    (input: any, context?: PluginContext): Promise<any>;
}

export interface PluginContext {
    job_id: string;
    flow_id: string;
    workspace_id: string;
    user_id: string;
    metadata?: any;
    // LeanEZ client for server communication
    client?: any;
}

export interface PluginConfig {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    homepage?: string;
    functions: PluginFunctionConfig[];
    dependencies?: string[];
    environment?: Record<string, string>;
}

export interface PluginFunctionConfig {
    name: string;
    description?: string;
    input_schema?: Record<string, any>;
    output_schema?: Record<string, any>;
    required_permissions?: string[];
    rate_limit?: {
        max_calls: number;
        window_ms: number;
    };
}

export interface PluginHealthStatus {
    plugin_id: string;
    status: 'healthy' | 'unhealthy' | 'degraded';
    last_check: string;
    error?: string;
}

export interface PluginMetrics {
    plugin_id: string;
    execution_count: number;
    average_execution_time: number;
    last_execution: string | null;
    error_count: number;
}

export interface InterPluginMessage {
    from_plugin: string;
    to_plugin: string;
    function_name: string;
    data: any;
    context?: Partial<PluginContext>;
    timeout?: number;
    retry_count?: number;
}

export interface PluginEvent {
    event_type: 'execution_started' | 'execution_completed' | 'execution_failed' | 'plugin_registered' | 'plugin_unregistered';
    plugin_id: string;
    timestamp: string;
    data?: any;
}

// SDK Configuration Types
export interface SDKConfig {
    leanez_base_url?: string; // LeanEZ server URL
    leanez_api_key?: string; // API key for authentication
    default_timeout?: number;
    max_retries?: number;
    log_level?: 'debug' | 'info' | 'warn' | 'error';
    enable_metrics?: boolean;
    enable_health_checks?: boolean;
    plugins_path?: string; // Path to plugins directory
}

// Error Types
export class PluginExecutionError extends Error {
    constructor(
        message: string,
        public plugin_id: string,
        public function_name: string,
        public original_error?: Error
    ) {
        super(message);
        this.name = 'PluginExecutionError';
    }
}

export class PluginTimeoutError extends Error {
    public readonly timeout: number;
    
    constructor(timeout: number) {
        super(`Plugin execution timed out after ${timeout}ms`);
        this.name = 'PluginTimeoutError';
        this.timeout = timeout;
    }
}

export class PluginNotFoundError extends Error {
    constructor(pluginId: string) {
        super(`Plugin not found: ${pluginId}`);
        this.name = 'PluginNotFoundError';
    }
}

export class PluginLoadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PluginLoadError';
    }
}

// Constants
export const SDK_VERSION = '1.0.0';
export const DEFAULT_TIMEOUT = 30000; // 30 seconds
export const DEFAULT_RETRY_COUNT = 3;
export const DEFAULT_QUEUE_PREFIX = 'plugin';

// Utility Types
export type PluginStatus = 'registered' | 'running' | 'stopped' | 'error';
export type ExecutionPriority = 'low' | 'normal' | 'high' | 'critical';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Plugin Manifest - loaded from manifest.json
 */
export interface PluginManifest {
    id: string; // Format: plugin-name-fingerprint
    name: string;
    version: string;
    description?: string;
    author?: string;
    functions: PluginFunctionDefinition[];
}

/**
 * Plugin Function Definition in manifest
 */
export interface PluginFunctionDefinition {
    name: string;
    description?: string;
    input_schema?: Record<string, any>;
    output_schema?: Record<string, any>;
    required_permissions?: string[];
    rate_limit?: {
        max_calls: number;
        window_ms: number;
    };
} 