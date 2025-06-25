/**
 * LeanEZ Plugin SDK
 * 
 * Main entry point for plugin development.
 * This can be extracted into @leanez/sdk npm package.
 */

// Export all IO modules
export * from './services/LLMIO';
export * from './services/RedisIO';  
export * from './services/BullIO';
export * from './services/PubSubIO';
export * from './services/MongoIO';
export * from './services/ContextIO';

// Export types
export * from './types';

// Remove auto-initialization and create controlled initialization function

/**
 * Initialize LeanEZ SDK with proper order and configuration
 */
export async function initializeSDK(config?: {
  // Redis configurations
  localRedis?: import('redis').RedisClientOptions;
  backendRedis?: import('redis').RedisClientOptions;
  
  // MongoDB configuration
  mongodb?: {
    uri?: string;
    options?: any;
  };
  
  // Other service configurations
  enableBullQueues?: boolean;
  enableContext?: boolean;
  enableLLM?: boolean;
}) {
  console.log('[SDK] Initializing LeanEZ SDK...');
  
  try {
    // 1. Initialize RedisIO first (local Redis for storage/cache)
    const { RedisIO } = require('./services/RedisIO');
    if (config?.localRedis) {
      RedisIO.init(config.localRedis);
    } else {
      RedisIO.init(); // Use environment variables
    }
    console.log('[SDK] ✅ RedisIO initialized');
  } catch (error) {
    console.warn('[SDK] ⚠️  RedisIO initialization failed:', error);
  }

  try {
    // 2. Initialize PubSubIO (backend communication)
    const { PubSubIO } = require('./services/PubSubIO');
    if (config?.backendRedis) {
      PubSubIO.init(config.backendRedis);
    } else {
      PubSubIO.init(); // Auto-detect backend Redis from env
    }
    console.log('[SDK] ✅ PubSubIO initialized');
  } catch (error) {
    console.warn('[SDK] ⚠️  PubSubIO initialization failed:', error);
  }

  try {
    // 3. Initialize MongoDB (optional)
    if (config?.mongodb?.uri || process.env.MONGODB_URI || process.env.MONGO_URL) {
      const { MongoIO } = require('./services/MongoIO');
      if (config?.mongodb) {
        MongoIO.init(config.mongodb.uri, config.mongodb.options);
      } else {
        MongoIO.init();
      }
      console.log('[SDK] ✅ MongoIO initialized');
    }
  } catch (error) {
    console.warn('[SDK] ⚠️  MongoIO initialization failed:', error);
  }

  try {
    // 4. Initialize BullIO (job queues - depends on Redis)
    if (config?.enableBullQueues !== false) {
      const { BullIO } = require('./services/BullIO');
      BullIO.init();
      console.log('[SDK] ✅ BullIO initialized');
    }
  } catch (error) {
    console.warn('[SDK] ⚠️  BullIO initialization failed:', error);
  }

  try {
    // 5. Initialize ContextIO (depends on Redis)
    if (config?.enableContext !== false) {
      const { ContextIO } = require('./services/ContextIO');
      ContextIO.init();
      console.log('[SDK] ✅ ContextIO initialized');
    }
  } catch (error) {
    console.warn('[SDK] ⚠️  ContextIO initialization failed:', error);
  }

  try {
    // 6. Initialize LLMIO last (depends on PubSubIO)
    if (config?.enableLLM !== false) {
      const { LLMIO } = require('./services/LLMIO');
      LLMIO.init();
      console.log('[SDK] ✅ LLMIO initialized');
    }
  } catch (error) {
    console.warn('[SDK] ⚠️  LLMIO initialization failed:', error);
  }

  console.log('[SDK] 🎉 SDK initialization completed');
}

// Auto-initialize SDK when imported (no manual initializeSDK() required)
// This provides the convenience of automatic setup while maintaining the new architecture
async function autoInitializeSDK() {
  try {
    console.log('[SDK] Auto-initializing LeanEZ SDK...');
    
    // Auto-detect configuration from environment variables
    await initializeSDK();
    
    console.log('[SDK] ✅ Auto-initialization completed');
  } catch (error) {
    console.error('[SDK] ❌ Auto-initialization failed:', error);
    console.error('[SDK] Please check your environment variables or call initializeSDK() manually');
  }
}

// Auto-initialize when module is imported
autoInitializeSDK(); 