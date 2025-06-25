// LLMIO Types
export interface LLMOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: any;
}

export interface EmbeddingOptions {
  model?: string;
  dimensions?: number;
  [key: string]: any;
}

export interface AssistantOptions {
  model?: string;
  instructions?: string;
  tools?: any[];
  [key: string]: any;
}

// Plugin Security Types
export interface PluginSecurityConfig {
  maxMemory: string;
  maxCpus: number;
  maxProcesses: number;
  allowedNetworks: string[];
  allowedVolumes: string[];
  capabilities: string[];
  readOnlyRootFilesystem: boolean;
  noNewPrivileges: boolean;
  runAsNonRoot: boolean;
}

export interface ManagedPlugin {
  id: string;
  name: string;
  version: string;
  containerId: string;
  status: 'starting' | 'running' | 'stopped' | 'error';
  securityConfig: PluginSecurityConfig;
  createdAt: Date;
  lastHealthCheck?: Date;
  resourceUsage?: {
    cpuUsage: number;
    memoryUsage: number;
    networkIO: { rx: number; tx: number };
  };
}

// Plugin Manifest Types
export interface PluginFunction {
  name: string;
  description: string;
  inputs: Record<string, any>;
  outputs: Record<string, any>;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  capabilities?: string[];
  functions: PluginFunction[];
}

export interface PluginConfig {
  manifest: PluginManifest;
  path: string;
  env?: Record<string, string>;
} 