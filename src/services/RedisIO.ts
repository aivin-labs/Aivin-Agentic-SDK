import { createClient } from 'redis';
import type { RedisClientType, RedisClientOptions, SetOptions } from 'redis';

/**
 * RedisIO - Redis connection manager với helper methods
 * Manages connection và cung cấp các methods tiện ích
 */
export class RedisIO {
  private static client: RedisClientType;
  private static subscriber: RedisClientType;
  private static isInitialized = false;
  private static config: RedisClientOptions = {};
  private static connectUrl: string;

  /**
   * Initialize Redis connection
   */
  static init(config?: RedisClientOptions): void {
    if (this.isInitialized) return;

    // Build config from environment variables
    const envConfig: RedisClientOptions = {};
    
    if (process.env.REDIS_URL) {
      envConfig.url = process.env.REDIS_URL;
      this.connectUrl = process.env.REDIS_URL;
    } else {
      envConfig.socket = {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379')
      };
      if (process.env.REDIS_PASSWORD) {
        envConfig.password = process.env.REDIS_PASSWORD;
      }
      if (process.env.REDIS_DB) {
        envConfig.database = parseInt(process.env.REDIS_DB);
      }
      
      // Build URL for display purposes
      const user = process.env.REDIS_USER || '';
      const pass = process.env.REDIS_PASSWORD || '';
      const host = process.env.REDIS_HOST || 'localhost';
      const port = process.env.REDIS_PORT || '6379';
      this.connectUrl = `redis://${user ? `${user}:${pass}@` : ''}${host}:${port}`;
    }

    this.config = { ...envConfig, ...config };

    try {
      this.client = createClient(this.config) as RedisClientType;
      
      this.client.on('connect', () => {
        console.log('[RedisIO] Connected to Redis');
      });

      this.client.on('error', (err) => {
        console.error('[RedisIO] Redis error:', err);
      });

      this.client.on('disconnect', () => {
        console.log('[RedisIO] Redis disconnected');
      });

      // Connect to Redis
      this.client.connect();
      this.isInitialized = true;
      
      console.log('[RedisIO] Initialized');
    } catch (error) {
      console.error('[RedisIO] Initialization failed:', error);
      throw error;
    }
  }

  static getConfig(): RedisClientOptions {
    return this.config;
  }

  /**
   * Get connection URL
   */
  static get url(): string {
    return this.connectUrl;
  }

  /**
   * Kiểm tra key có tồn tại không
   */
  static async has(key: string): Promise<number> {
    return this.client.exists(key);
  }

  /**
   * Lấy dữ liệu từ Redis với hỗ trợ initData
   */
  static async get<T = any>(key: string, initData?: T): Promise<T | null> {
    try {
      const data = await this.client.get(key);
      if (data == null && initData != null) {
        await this.client.set(key, JSON.stringify(initData));
        return initData;
      }
      return data ? JSON.parse(data) : null;
    } catch (err) {
      // Return raw data if JSON parse fails, or fallback to initData
      const rawData = await this.client.get(key);
      return (rawData as any) ?? initData ?? null;
    }
  }

  /**
   * Làm sạch dữ liệu bằng cách loại bỏ các trường không phù hợp
   */
  private static sanitizeData(data: any): any {
    // Kiểm tra các type không cần sanitize
    if (data === null || data === undefined || typeof data !== 'object' || 
        Array.isArray(data) || data instanceof Date || typeof data === 'function') {
      return data;
    }

    const cleaned: any = {};
    
    for (const [key, value] of Object.entries(data)) {
      // Bỏ qua các giá trị undefined, null
      if (value === undefined || value === null) {
        continue;
      }
      
      // Bỏ qua string rỗng
      if (typeof value === 'string' && value.trim() === '') {
        continue;
      }
      
      // Bỏ qua object/array rỗng (nhưng không phải Date hoặc Function)
      if (typeof value === 'object' && value !== null && 
          !(value instanceof Date) && typeof value !== 'function' &&
          Object.keys(value).length === 0) {
        continue;
      }
      
      // Đệ quy sanitize cho nested objects
      if (typeof value === 'object' && value !== null && 
          !Array.isArray(value) && !(value instanceof Date) && typeof value !== 'function') {
        cleaned[key] = this.sanitizeData(value);
      } else {
        cleaned[key] = value;
      }
    }

    return cleaned;
  }

  /**
   * Cập nhật dữ liệu vào Redis
   */
  static async update(key: string, data: any, opts?: SetOptions): Promise<string | null> {
    let content: string;
    
    if (typeof data === 'object' && data !== null) {
      // Làm sạch dữ liệu trước khi lưu
      const sanitizedData = RedisIO.sanitizeData(data);
      content = JSON.stringify(sanitizedData);
    } else {
      content = String(data);
    }
    
    return this.client.set(key, content, opts);
  }

  /**
   * Xóa key khỏi Redis
   */
  static async delete(key: string): Promise<number> {
    return this.client.del(key);
  }

  /**
   * Publish message tới channel
   */
  static async publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  /**
   * Subscribe tới channel
   */
  static async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    if (!this.subscriber) {
      this.subscriber = createClient(this.config) as RedisClientType;
      await this.subscriber.connect();
    }

    await this.subscriber.subscribe(channel, (message) => {
      callback(message);
    });
  }

  /**
   * Unsubscribe khỏi channel
   */
  static async unsubscribe(channel: string): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.unsubscribe(channel);
    }
  }

  /**
   * Get Redis client instance - để thực hiện advanced operations
   */
  static getClient(): RedisClientType {
    return this.client;
  }

  /**
   * Check if Redis is initialized
   */
  static get initialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Close Redis connections
   */
  static async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = undefined as any;
    }
    if (this.subscriber) {
      await this.subscriber.quit();
      this.subscriber = undefined as any;
    }
    this.isInitialized = false;
    console.log('[RedisIO] All connections closed');
  }
} 