/**
 * LeanEZ Plugin SDK
 * 
 * Main entry point for plugin development.
 * This can be extracted into @leanez/sdk npm package.
 */

// Export types (always available)
export * from './types';

// Conditional exports for services based on stacks
export { LLMIO } from './services/LLMIO';
export { RedisIO } from './services/RedisIO';
export { PubSubIO } from './services/PubSubIO';
export { MongoIO } from './services/MongoIO';
export { ContextIO } from './services/ContextIO';
export { BullIO } from './services/BullIO';

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
  
  // Stack configuration
  stacks?: string[];
}) {
  console.log('[SDK] Initializing LeanEZ SDK...');
  
  // Check if specific stacks are enabled
  const stacks = config?.stacks || (process.env.STACKS ? process.env.STACKS.split(',') : []);
  
  const needsRedis = stacks.includes('REDIS_CACHE') || stacks.includes('BACKGROUND_JOBS') || stacks.includes('REALTIME_COMMUNICATION');
  const needsMongo = stacks.includes('MONGODB');
  const needsBull = stacks.includes('BACKGROUND_JOBS') || config?.enableBullQueues === true;
  const needsPubSub = stacks.includes('REALTIME_COMMUNICATION') || needsBull;
  const needsLLM = stacks.includes('AI_LLM') || config?.enableLLM !== false;
  
  // 1. Initialize RedisIO if needed
  if (needsRedis) {
    try {
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
  } else {
    console.log('[SDK] ⏭️  RedisIO skipped (not needed for current stacks)');
  }

  // 2. Initialize PubSubIO if needed
  if (needsPubSub) {
    try {
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
  } else {
    console.log('[SDK] ⏭️  PubSubIO skipped (not needed for current stacks)');
  }

  // 3. Initialize MongoDB if needed
  if (needsMongo) {
    try {
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
  } else {
    console.log('[SDK] ⏭️  MongoIO skipped (not needed for current stacks)');
  }

  // 4. Initialize BullIO if needed
  if (needsBull) {
    try {
      const { BullIO } = require('./services/BullIO');
      BullIO.init();
      console.log('[SDK] ✅ BullIO initialized');
    } catch (error) {
      console.warn('[SDK] ⚠️  BullIO initialization failed:', error);
    }
  } else {
    console.log('[SDK] ⏭️  BullIO skipped (not needed for current stacks)');
  }

  // 5. Initialize ContextIO if Redis is available
  if (needsRedis && config?.enableContext !== false) {
    try {
      const { ContextIO } = require('./services/ContextIO');
      ContextIO.init();
      console.log('[SDK] ✅ ContextIO initialized');
    } catch (error) {
      console.warn('[SDK] ⚠️  ContextIO initialization failed:', error);
    }
  } else {
    console.log('[SDK] ⏭️  ContextIO skipped (Redis not available or disabled)');
  }

  // 6. Initialize LLMIO only if PubSub is available (LLMIO requires PubSub)
  if (needsLLM && needsPubSub) {
    try {
      const { LLMIO } = require('./services/LLMIO');
      LLMIO.init();
      console.log('[SDK] ✅ LLMIO initialized');
    } catch (error) {
      console.warn('[SDK] ⚠️  LLMIO initialization failed:', error);
    }
  } else if (needsLLM && !needsPubSub) {
    console.log('[SDK] ⚠️  LLMIO skipped (requires PubSub but PubSub not available)');
  } else {
    console.log('[SDK] ⏭️  LLMIO skipped (not needed for current stacks)');
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