/**
 * LLM Data Transfer Objects
 * 
 * Tham khảo từ src/llm/dto/LLMDTO.ts
 * Chỉ chứa các interface cần thiết cho SDK
 */

export interface MediaItem {
  id: string;
  url: string;
  mime: string;
  extension?: string;
  name?: string;
  size?: number;
}

export interface PromptOptions {
  temperature?: number;
  provider?: string;
  engine?: string;
  seed?: number;
  schema?: object;
  lang?: string;
  model?: string;
  emoji?: boolean;
  style?: string;
  reference?: string;
  audio?: MediaItem;
  video?: MediaItem;
  images?: MediaItem[];
  files?: MediaItem[];
  role?: string;
  context?: any;
  format?: any;
  filter?: string[];
  check?: string;
  ttl?: number;
  instructions?: string;
  threadId?: string;
  maxTokens?: number;
}

export interface CalculateParamDTO {
  inputText: string;
  outputText: string;
  model: string;
  cached: boolean;
  opts?: PromptOptions;
}

// Legacy interfaces for backward compatibility
export interface LLMRequestOptions extends PromptOptions {}
export interface LLMRequest {
  type: 'prompt' | 'embedding' | 'getAssistant' | 'newAssistantThread' | 
        'getAssistantThread' | 'updateAssistant' | 'promptAssistant' | 'calculateTokens';
  request?: any;
  text?: string;
  assistantId?: string;
  threadId?: string;
  llmId?: string;
  assistant?: any;
  options?: LLMRequestOptions;
  driver?: string;
  pluginId: string;
  timestamp: number;
}

export interface LLMConfig {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  serverChannel?: string;  // Channel để giao tiếp với server
  pluginId?: string;       // ID của plugin
}

export interface Assistant {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  model?: string;
  tools?: any[];
}

export interface AssistantThread {
  id: string;
  assistantId?: string;
  metadata?: Record<string, any>;
  createdAt: number;
}

// Exception classes
export class ThreadBusyException extends Error {
  constructor(message: string = 'Thread is busy and cannot accept new messages') {
    super(message);
    this.name = 'ThreadBusyException';
  }
}

export class ThreadRunActiveException extends Error {
  constructor(message: string = 'Thread has an active run and cannot accept new messages') {
    super(message);
    this.name = 'ThreadRunActiveException';
  }
}

// Type aliases for convenience
export type LLMOptions = PromptOptions;
export type EmbeddingOptions = PromptOptions;
export type AssistantOptions = PromptOptions; 