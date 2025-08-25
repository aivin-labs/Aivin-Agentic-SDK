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

// Plugin Security types removed - this is server-side infrastructure

// ManagedPlugin removed - this is server-side infrastructure, not client SDK

// Plugin types moved to ./types/PluginTypes.ts for consistency 