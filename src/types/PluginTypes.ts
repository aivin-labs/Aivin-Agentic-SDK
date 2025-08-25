/**
 * Plugin SDK Type Definitions
 * 
 * This file contains all type definitions for the Plugin SDK.
 * Can be extracted into a separate npm package later.
 */

export interface PluginExecutionResult {
    success: boolean;
    result?: any;
    error?: string;
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

// Utility Types
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Plugin Manifest - loaded from manifest.json (Single method pattern)
 * Based on simplified structure from plugindto.ts
 */
export interface PluginManifest {
    id: string; // Auto-generated hex ID
    name: string; // Plugin name (unique identifier)
    input?: string | object; // Simple input description/schema
    output?: string | object; // Simple output description/schema
    depend_on?: string; // Plugin dependencies
    description: string;
    author?: string;
    email?: string;
    is_official?: boolean;
    is_verified?: boolean;
    trigger_type?: TriggerType[];
    initial?: object; // Initial configuration
    version?: string; // Optional version
}

// Old complex function/input/output definitions removed
// Now using flexible input/output format in manifest

/**
 * Trigger Types enum
 */
export enum TriggerType {
    MANUAL = 'manual',
    SCHEDULE = 'schedule',
    EVENT = 'event',
    WEBHOOK = 'webhook',
    API = 'api',
    CHAT = 'chat'
} 