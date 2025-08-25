import { IsNotEmpty, IsObject, IsOptional, IsString } from "class-validator";
import { AgentContextDTO } from "src/agentic/dto/AgenticDTO";

export enum TriggerType {
    MANUAL = 'manual',
    SCHEDULE = 'schedule',
    EVENT = 'event',
    WEBHOOK = 'webhook',
    API = 'api',
    CHAT = 'chat'
}
// Plugin Manifest Interface (based on MANIFEST.md) - Core plugin definition
export interface PluginManifest {
    id: string;
    name: string;
    input?: string | object;
    output?: string | object;
    depend_on?: string;
    description: string;
    author?: string;
    email?: string;
    is_official?: boolean;
    is_verified?: boolean;
    trigger_type?: TriggerType[];
    initial?: object;
}

// DTO for creating plugin execution
export interface CreatePluginExecutionDto {
    workspace_id: string;
    user_id: string;
    plugin_id: string;
    params?: any;
    trigger_type?: TriggerType[];
    metadata?: any; // Optional - for setup/config purposes
}

export interface PluginRunnerContext {
    process_context?: {       // Context available cho step này
        previousLevelResults?: any[],  // Results từ level trước
        parentResult?: any,            // Result từ parent step (sub-planning)
        siblingResults?: any[],        // Results từ sibling steps (nếu cần)
        ancestorResults?: any[]        // Results từ ancestor paths (deep nesting)
    };
    manifest: PluginManifest;
    context: AgentContextDTO;
}

export class PluginDeploymentDto {
    id: string;
    manifest: any;
    stacks?: string[];
    files: Record<string, string>;
    user_id?: string;
    developer_email?: string;
}

export class InstallPluginRequest {
    @IsNotEmpty()
    @IsString()
    workspace_id: string;

    @IsNotEmpty()
    @IsString()
    plugin_id: string;

    @IsOptional()
    @IsObject()
    arguments?: any;
}