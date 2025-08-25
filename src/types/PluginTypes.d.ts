/**
 * Plugin SDK Type Definitions
 *
 * This file contains all type definitions for the Plugin SDK.
 * Can be extracted into a separate npm package later.
 */
// Single method pattern - simplified execution data
export interface PluginExecutionData {
    execution_id?: string;
    plugin_name: string; // Plugin name instead of plugin_id
    data: any; // Single input data
    ctx?: {
        user: any;
        workspace: any;
        session: any;
        metadata?: any;
    };
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
export interface SDKConfig {
    leanez_base_url?: string;
    leanez_api_key?: string;
    default_timeout?: number;
    max_retries?: number;
    log_level?: 'debug' | 'info' | 'warn' | 'error';
    enable_metrics?: boolean;
    enable_health_checks?: boolean;
    plugins_path?: string;
}
export declare class PluginExecutionError extends Error {
    plugin_id: string;
    function_name: string;
    original_error?: Error | undefined;
    constructor(message: string, plugin_id: string, function_name: string, original_error?: Error | undefined);
}
export declare class PluginTimeoutError extends Error {
    readonly timeout: number;
    constructor(timeout: number);
}
export declare class PluginNotFoundError extends Error {
    constructor(pluginId: string);
}
export declare class PluginLoadError extends Error {
    constructor(message: string);
}
export declare const SDK_VERSION = "1.0.0";
export declare const DEFAULT_TIMEOUT = 30000;
export declare const DEFAULT_RETRY_COUNT = 3;
export declare const DEFAULT_QUEUE_PREFIX = "plugin";
export type PluginStatus = 'registered' | 'running' | 'stopped' | 'error';
export type ExecutionPriority = 'low' | 'normal' | 'high' | 'critical';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/**
 * Plugin Manifest - loaded from manifest.json
 */
export interface PluginManifest {
    id: string;
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
/**
 * Plugin Handler - exported from handler.ts
 */
export interface PluginHandler {
    [functionName: string]: PluginFunction;
}
/**
 * Plugin Discovery Result
 */
export interface DiscoveredPlugin {
    manifest: PluginManifest;
    handler: PluginHandler;
    path: string;
}
