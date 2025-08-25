import { RedisIO } from './RedisIO';
import { createClient } from 'redis';
import type { RedisClientType, RedisClientOptions } from 'redis';
import type { PubSubMessage, RequestOptions } from '../dto/PubSubDTO';

/**
 * Simple Logger for PubSubIO
 */
class Logger {
  static log(message: string, ...args: any[]): void {
    console.log(`[${new Date().toISOString()}] ${message}`, ...args);
  }
  
  static error(message: string, ...args: any[]): void {
    console.error(`[${new Date().toISOString()}] ERROR: ${message}`, ...args);
  }
  
  static warning(message: string, ...args: any[]): void {
    console.warn(`[${new Date().toISOString()}] WARN: ${message}`, ...args);
  }
}

/**
 * PubSubIO - Redis Pub/Sub wrapper optimized for LeanEZ backend communication
 * Supports dual Redis connections:
 * - Local Redis (via RedisIO) for storage/cache
 * - Remote Redis (LeanEZ backend) for communication
 * 
 * Enhanced with service registration capabilities from serverpubsub.ts
 */
export class PubSubIO {
  private static isInitialized = false;
  private static activeRequests = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();
  private static subscriptions = new Map<string, any>();
  
  // Separate Redis client for LeanEZ backend communication
  private static backendClient: RedisClientType;
  private static backendSubscriber: RedisClientType;
  private static backendConfig: RedisClientOptions;
  private static useRemoteBackend = false;

  static init(backendRedisConfig?: RedisClientOptions): void {
    if (this.isInitialized) return;
    
    // Setup backend Redis connection if provided
    if (backendRedisConfig) {
      this.setupBackendRedis(backendRedisConfig);
    } else {
      // Check environment for backend Redis config
      this.setupBackendRedisFromEnv();
    }
    
    this.setupResponseHandler();
    
    Logger.log('[PubSubIO] Initialized');
    Logger.log(`  - Local Redis: ${RedisIO.url} (via RedisIO)`);
    Logger.log(`  - Backend Redis: ${this.useRemoteBackend ? 'Remote server' : 'Same as local'}`);
    this.isInitialized = true;
  }

  /**
   * Setup Redis connection for LeanEZ backend communication
   */
  private static setupBackendRedis(config: RedisClientOptions): void {
    try {
      this.backendConfig = config;
      this.backendClient = createClient(config) as RedisClientType;
      
      this.backendClient.on('connect', () => {
        console.log('[PubSubIO] Connected to LeanEZ backend Redis');
      });

      this.backendClient.on('error', (err) => {
        console.error('[PubSubIO] Backend Redis error:', err);
      });

      this.backendClient.on('disconnect', () => {
        console.log('[PubSubIO] Backend Redis disconnected');
      });

      this.backendClient.connect();
      this.useRemoteBackend = true;
    } catch (error) {
      console.error('[PubSubIO] Backend Redis setup failed:', error);
      console.log('[PubSubIO] Falling back to local Redis');
      this.useRemoteBackend = false;
    }
  }

  /**
   * Setup backend Redis from environment variables
   */
  private static setupBackendRedisFromEnv(): void {
    const backendRedisUrl = process.env.LEANEZ_REDIS_URL;
    const backendRedisHost = process.env.LEANEZ_REDIS_HOST;
    const backendRedisPort = process.env.LEANEZ_REDIS_PORT;
    
    if (backendRedisUrl) {
      this.setupBackendRedis({ url: backendRedisUrl });
    } else if (backendRedisHost && backendRedisPort) {
      const config: RedisClientOptions = {
        socket: {
          host: backendRedisHost,
          port: parseInt(backendRedisPort)
        }
      };
      
      if (process.env.LEANEZ_REDIS_PASSWORD) {
        config.password = process.env.LEANEZ_REDIS_PASSWORD;
      }
      
      if (process.env.LEANEZ_REDIS_DB) {
        config.database = parseInt(process.env.LEANEZ_REDIS_DB);
      }
      
      this.setupBackendRedis(config);
    } else {
      console.log('[PubSubIO] No backend Redis config found, using local Redis');
      this.useRemoteBackend = false;
    }
  }

  /**
   * Get the appropriate Redis client for backend communication
   */
  private static getBackendClient(): RedisClientType {
    if (this.useRemoteBackend && this.backendClient) {
      return this.backendClient;
    }
    return RedisIO.getClient();
  }

  /**
   * Get the appropriate subscriber for backend communication
   */
  private static async getBackendSubscriber(): Promise<RedisClientType> {
    if (this.useRemoteBackend) {
      if (!this.backendSubscriber) {
        this.backendSubscriber = createClient(this.backendConfig) as RedisClientType;
        await this.backendSubscriber.connect();
      }
      return this.backendSubscriber;
    }
    
    // Use RedisIO's subscriber for local Redis
    return RedisIO.getClient().duplicate();
  }

  /**
   * Setup global response handler for request-response pattern
   */
  private static async setupResponseHandler(): Promise<void> {
    // Note: We'll subscribe to specific response channels in request() method
    // This is more efficient than using wildcard patterns
    console.log('[PubSubIO] Response handler ready');
  }

  /**
   * Emit event to channel
   */
  static async emit(channel: string, data: any, options?: RequestOptions): Promise<number> {
    return await this.publish(channel, data, options);
  }

  /**
   * Publish message to LeanEZ backend
   */
  static async publish(channel: string, data: any, options?: RequestOptions): Promise<number> {
    const message: PubSubMessage = {
      id: this.generateId(),
      channel,
      data,
      timestamp: Date.now(),
      sender: options?.sender
    };

    const client = this.getBackendClient();
    return await client.publish(channel, JSON.stringify(message));
  }

  /**
   * Request-response pattern with LeanEZ backend
   */
  static async request<T = any>(channel: string, data: any, options?: RequestOptions): Promise<T> {
    const requestId = this.generateId();
    const responseChannel = `callback:${requestId}`;
    const message: PubSubMessage = {
      id: requestId,
      channel,
      data,
      timestamp: Date.now(),
      sender: options?.sender,
      responseChannel
    };

    return new Promise<T>(async (resolve, reject) => {
      // Store request for response handling without timeout
      this.activeRequests.set(requestId, { resolve, reject });

      try {
        // Subscribe to specific response channel
        const subscriber = await this.getBackendSubscriber();
        await subscriber.subscribe(responseChannel, (rawMessage: string) => {
          if (this.activeRequests.has(requestId)) {
            const request = this.activeRequests.get(requestId)!;
            this.activeRequests.delete(requestId);
            
            try {
              const response = JSON.parse(rawMessage);
              if (response.error) {
                request.reject(new Error(response.error));
              } else {
                request.resolve(response.data || response);
              }
            } catch {
              request.resolve(rawMessage as T);
            }
          }
        });

        // Send request to LeanEZ backend
        const client = this.getBackendClient();
        await client.publish(channel, JSON.stringify(message));
        
      } catch (error) {
        if (this.activeRequests.has(requestId)) {
          this.activeRequests.delete(requestId);
          reject(error);
        }
      }
    });
  }

  /**
   * Subscribe to LeanEZ backend channels
   */
  static async subscribe(channel: string, handler: (message: PubSubMessage) => void): Promise<void> {
    const subscriber = await this.getBackendSubscriber();
    
    await subscriber.subscribe(channel, (rawMessage: string) => {
      try {
        const message: PubSubMessage = JSON.parse(rawMessage);
        handler(message);
      } catch (error) {
        // Fallback: treat as raw data
        handler({
          id: 'unknown',
          channel,
          data: rawMessage,
          timestamp: Date.now()
        });
      }
    });
  }

  /**
   * Listen for requests from LeanEZ backend and auto-respond
   */
  static async listen(channel: string, handler: (data: any) => Promise<any> | any): Promise<void> {
    await this.subscribe(channel, async (message: PubSubMessage) => {
      if (message.responseChannel) {
        try {
          const result = await handler(message.data);
          const client = this.getBackendClient();
          await client.publish(message.responseChannel, JSON.stringify({
            requestId: message.id,
            data: result
          }));
        } catch (error) {
          const client = this.getBackendClient();
          await client.publish(message.responseChannel, JSON.stringify({
            requestId: message.id,
            error: error instanceof Error ? error.message : 'Unknown error'
          }));
        }
      }
    });
  }

  /**
   * Get connection info for debugging
   */
  static getConnectionInfo(): {
    localRedis: string;
    backendRedis: string;
    useRemoteBackend: boolean;
  } {
    return {
      localRedis: RedisIO.url,
      backendRedis: this.useRemoteBackend ? 'Remote server' : 'Same as local',
      useRemoteBackend: this.useRemoteBackend
    };
  }

  /**
   * Get active requests count (for monitoring)
   */
  static getActiveRequestsCount(): number {
    return this.activeRequests.size;
  }

  /**
   * Clean up expired requests
   */
  static cleanup(): void {
    const info = this.getConnectionInfo();
    console.log(`[PubSubIO] Active requests: ${this.activeRequests.size}`);
    console.log(`[PubSubIO] Local Redis: ${info.localRedis}`);
    console.log(`[PubSubIO] Backend Redis: ${info.backendRedis}`);
  }

  // Server-only methods removed - plugins chỉ cần request/response pattern

  /**
   * Close backend connections
   */
  static async close(): Promise<void> {
    try {
      // Clear all pending requests
      for (const [id, pending] of this.activeRequests) {
        pending.reject(new Error('PubSubIO is closing'));
      }
      this.activeRequests.clear();
      
      // Clean up subscriptions
      this.subscriptions.clear();
      
      if (this.backendSubscriber) {
        await this.backendSubscriber.quit();
      }
      if (this.backendClient) {
        await this.backendClient.quit();
      }
      
      this.isInitialized = false;
      Logger.log('[PubSubIO] Backend Redis connections closed');
    } catch (error) {
      Logger.error('[PubSubIO] Error closing backend connections:', error);
    }
  }

  private static generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }
} 