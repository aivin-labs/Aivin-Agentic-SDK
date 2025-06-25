import type {
  Assistant,
  AssistantThread,
  LLMConfig,
  LLMRequest,
  LLMRequestOptions
} from '../dto/LLMDTO';
import { PubSubIO } from './PubSubIO';

/**
 * LLMIO - Simple wrapper gửi LLM requests qua Redis Pub/Sub đến LeanEZ server
 */
export class LLMIO {
  private static isInitialized = false;
  private static serverChannel = 'llm:server';
  private static pluginId = 'sdk-client';

  static init(): void {
    if (this.isInitialized) return;

    this.isInitialized = true;
    console.log(`[LLMIO] Initialized for plugin: ${this.pluginId}`);
  }

  /**
   * Gửi prompt request đến LeanEZ server
   */
  static async prompt(request: any, opts?: LLMRequestOptions): Promise<any> {
    const requestData: LLMRequest = {
      type: 'prompt',
      request,
      options: opts,
      pluginId: this.pluginId,
      timestamp: Date.now()
    };

    return await PubSubIO.request(this.serverChannel, requestData, {
      sender: this.pluginId
    });
  }

  /**
   * Gửi embedding request đến LeanEZ server
   */
  static async getEmbedding(data: string, opts?: LLMRequestOptions): Promise<number[]> {
    const requestData: LLMRequest = {
      type: 'embedding',
      text: data,
      options: opts,
      pluginId: this.pluginId,
      timestamp: Date.now()
    };

    const response = await PubSubIO.request(this.serverChannel, requestData, {
      sender: this.pluginId
    });

    return Array.isArray(response) ? response : [];
  }

  /**
   * Configure server connection
   */
  static configure(config: LLMConfig): void {
    if (config.serverChannel) {
      this.serverChannel = config.serverChannel;
    }
    if (config.pluginId) {
      this.pluginId = config.pluginId;
    }
    console.log(`[LLMIO] Configured - Channel: ${this.serverChannel}, Plugin: ${this.pluginId}`);
  }

  /**
   * Get assistant by ID
   */
  static async getAssistant(id: string): Promise<Assistant> {
    const requestData: LLMRequest = {
      type: 'getAssistant',
      assistantId: id,
      pluginId: this.pluginId,
      timestamp: Date.now()
    };

    return await PubSubIO.request(this.serverChannel, requestData, {
      sender: this.pluginId
    });
  }

  /**
   * Create new assistant thread
   */
  static async newAssistantThread(): Promise<string> {
    const requestData: LLMRequest = {
      type: 'newAssistantThread',
      pluginId: this.pluginId,
      timestamp: Date.now()
    };

    const response = await PubSubIO.request(this.serverChannel, requestData, {
      sender: this.pluginId
    });

    return response?.threadId || response;
  }

  /**
   * Get assistant thread by ID
   */
  static async getAssistantThread(id: string): Promise<AssistantThread> {
    const requestData: LLMRequest = {
      type: 'getAssistantThread',
      threadId: id,
      pluginId: this.pluginId,
      timestamp: Date.now()
    };

    return await PubSubIO.request(this.serverChannel, requestData, {
      sender: this.pluginId
    });
  }

  /**
   * Update assistant
   */
  static async updateAssistant(llmId: string, assistant: Partial<Assistant>): Promise<Assistant> {
    const requestData: LLMRequest = {
      type: 'updateAssistant',
      llmId,
      assistant,
      pluginId: this.pluginId,
      timestamp: Date.now()
    };

    return await PubSubIO.request(this.serverChannel, requestData, {
      sender: this.pluginId
    });
  }

  /**
   * Prompt assistant with thread
   */
  static async promptAssistant(
    threadId: string,
    llmId: string,
    request: string,
    opts?: LLMRequestOptions,
    driver?: string
  ): Promise<void> {
    const requestData: LLMRequest = {
      type: 'promptAssistant',
      threadId,
      llmId,
      request,
      options: opts,
      driver,
      pluginId: this.pluginId,
      timestamp: Date.now()
    };

    await PubSubIO.request(this.serverChannel, requestData, {
      sender: this.pluginId
    });
  }

  /**
   * Calculate tokens for text
   */
  static async calculateTokens(data: string): Promise<number> {
    const requestData: LLMRequest = {
      type: 'calculateTokens',
      text: data,
      pluginId: this.pluginId,
      timestamp: Date.now()
    };

    const response = await PubSubIO.request(this.serverChannel, requestData, {
      sender: this.pluginId
    });

    return typeof response === 'number' ? response : 0;
  }
}

// Re-export exceptions from DTO
export { ThreadBusyException, ThreadRunActiveException } from '../dto/LLMDTO';
