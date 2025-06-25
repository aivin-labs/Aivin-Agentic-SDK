import { EventEmitter } from 'events';
import { PubSubIO } from './services/PubSubIO';
import { BullIO } from './services/BullIO';
import { LocalTestServer } from './LocalTestServer';
import { LLMIO } from './services/LLMIO';
import * as fs from 'fs';
import * as path from 'path';
import { 
    PluginExecutionData, 
    PluginExecutionResult, 
    PluginManifest,
    SDKConfig,
    LogLevel 
} from './types/PluginTypes';

export interface PluginServerConfig extends SDKConfig {
  server_id?: string;
  queue_name?: string;
  enable_local_testing?: boolean;
  port?: number;
  plugins_path?: string;
}

export interface PluginJobData {
  execution_id: string;
  plugin_id: string;
  function_name: string;
  input_data: any;
  context: {
    job_id: string;
    flow_id: string;
    workspace_id: string;
    user_id: string;
    metadata?: any;
  };
  callback_queue?: string;
  timeout?: number;
}

interface LoadedPlugin {
  manifest: PluginManifest;
  handler: any;
  path: string;
}

/**
 * Plugin Server - Handles distributed plugin execution
 * Listens to Bull queue events from LeanEZ server and executes plugins
 */
export class PluginServer extends EventEmitter {
  private config: PluginServerConfig;
  private isRunning: boolean = false;
  private serverId: string;
  private queueName: string;
  private testServer: any = null; // LocalTestServer instance
  private plugin: LoadedPlugin | null = null; // Single plugin only

  constructor(config: PluginServerConfig = {}) {
    super();
    
    this.config = {
      server_id: config.server_id,
      queue_name: config.queue_name || 'plugin-execution',
      enable_local_testing: config.enable_local_testing ?? false,
      port: config.port || 8080,
      plugins_path: config.plugins_path || '.',
      ...config
    };

    this.serverId = config.server_id || 'temp-server-id';
    this.queueName = this.config.queue_name!;
  }

  /**
   * Start the plugin server
   */
  async start(): Promise<void> {
    try {
      console.log(`🚀 Starting Plugin Server...`);
      
      // Load single plugin first to get manifest
      await this.loadPlugin();
      
      if (!this.plugin) {
        throw new Error('No plugin loaded. Make sure manifest.json and handler.js exist.');
      }
      
      console.log(`✅ Loaded plugin: ${this.plugin.manifest.id} v${this.plugin.manifest.version}`);

      // Set server ID with "node:" prefix and plugin ID as plain manifest.id
      this.serverId = `node:${this.plugin.manifest.id}`;
      this.config.server_id = this.serverId;
      
      // Configure LLMIO with plain plugin ID (without prefix)
      LLMIO.configure({ pluginId: this.plugin.manifest.id });
      
      console.log(`📝 Server ID: ${this.serverId}`);
      console.log(`📝 Plugin ID: ${this.plugin.manifest.id}`);

      // Register plugin with LeanEZ
      await this.registerPlugin();
      console.log('✅ Plugin registered with LeanEZ');
      
      // Start listening to queue
      await this.startQueueListener();
      console.log(`✅ Listening to queue: ${this.queueName}`);

      // Start local testing server if enabled
      if (this.config.enable_local_testing) {
        await this.startLocalTestServer();
        console.log(`✅ Local test server started on port ${this.config.port}`);
      }

      this.isRunning = true;
      this.emit('server:started', { serverId: this.serverId });
      
      console.log(`🎉 Plugin Server started successfully!`);
      
    } catch (error) {
      const err = error as Error;
      console.error(`❌ Failed to start Plugin Server: ${err.message}`);
      throw error;
    }
  }

  /**
   * Stop the plugin server
   */
  async stop(): Promise<void> {
    try {
      console.log(`🛑 Stopping Plugin Server: ${this.serverId}`);
      
      this.isRunning = false;
      
      // Stop local test server
      if (this.testServer) {
        await this.testServer.stop();
      }
      
      this.emit('server:stopped', { serverId: this.serverId });
      console.log('✅ Plugin Server stopped');
      
    } catch (error) {
      const err = error as Error;
      console.error(`❌ Error stopping server: ${err.message}`);
    }
  }

  /**
   * Start listening to plugin execution requests
   */
  private async startQueueListener(): Promise<void> {
    await PubSubIO.listen(this.queueName, async (jobData: PluginJobData) => {
      console.log(`🔄 Received job via PubSub: ${jobData.plugin_id}.${jobData.function_name}`);
      
      try {
        const result = await this.executePluginJob(jobData);
        return result;
      } catch (error) {
        const err = error as Error;
        console.error(`❌ Job execution failed: ${err.message}`);
        return {
          success: false,
          error: err.message,
          execution_time: 0,
          timestamp: new Date().toISOString()
        };
      }
    });
    
    console.log(`🎧 Listening on PubSub channel: ${this.queueName}`);
  }

  /**
   * Load single plugin
   */
  private async loadPlugin(): Promise<void> {
    try {
      const pluginsPath = this.config.plugins_path!;
      const manifestPath = path.join(pluginsPath, 'manifest.json');
      const handlerPath = path.join(pluginsPath, 'handler.js');
      
      if (!fs.existsSync(manifestPath) || !fs.existsSync(handlerPath)) {
        throw new Error(`Plugin files not found. Expected manifest.json and handler.js in: ${pluginsPath}`);
      }
      
      // Load manifest
      const manifestContent = fs.readFileSync(manifestPath, 'utf8');
      const manifest: PluginManifest = JSON.parse(manifestContent);

      // Load handler
      delete require.cache[require.resolve(handlerPath)];
      const handler = require(handlerPath);

      // Store loaded plugin
      this.plugin = {
        manifest,
        handler,
        path: pluginsPath
      };

      console.log(`📦 Loaded plugin: ${manifest.id} v${manifest.version}`);
    } catch (error) {
      const err = error as Error;
      console.error(`❌ Failed to load plugin: ${err.message}`);
      throw error;
    }
  }

  /**
   * Register plugin with LeanEZ server
   */
  private async registerPlugin(): Promise<void> {
    try {
      const plugin = this.plugin!;

      await PubSubIO.emit('plugin-server-register', {
        server_id: this.serverId,
        queue_name: this.queueName,
        plugins: [
          {
            id: plugin.manifest.id,
            name: plugin.manifest.name,
            version: plugin.manifest.version,
            functions: plugin.manifest.functions
          }
        ],
        timestamp: new Date().toISOString()
      }, { sender: this.serverId });

      console.log(`📡 Registered plugin with LeanEZ`);
    } catch (error) {
      const err = error as Error;
      console.error(`❌ Failed to register plugin: ${err.message}`);
    }
  }

  /**
   * Execute plugin job
   */
  async executePluginJob(jobData: PluginJobData): Promise<PluginExecutionResult> {
    const startTime = Date.now();
    
    try {
      console.log(`🔄 Executing plugin job: ${jobData.plugin_id}.${jobData.function_name}`);
      
      // Validate plugin
      if (!this.plugin) {
        throw new Error('No plugin loaded');
      }
      
      if (this.plugin.manifest.id !== jobData.plugin_id) {
        throw new Error(`Plugin ID mismatch. Expected: ${this.plugin.manifest.id}, Received: ${jobData.plugin_id}`);
      }

      // Get function from handler
      const targetFunction = this.plugin.handler[jobData.function_name];
      if (!targetFunction || typeof targetFunction !== 'function') {
        throw new Error(`Function ${jobData.function_name} not found in plugin ${jobData.plugin_id}`);
      }

      // Execute plugin function
      const result = await targetFunction(jobData.input_data, jobData.context);
      
      // Send result back to LeanEZ
      if (jobData.callback_queue) {
        await this.sendResultToLeanEZ(jobData.execution_id, {
          success: true,
          result: result,
          execution_time: Date.now() - startTime,
          timestamp: new Date().toISOString()
        }, jobData.callback_queue);
      }
      
      const executionTime = Date.now() - startTime;
      console.log(`✅ Plugin executed successfully in ${executionTime}ms`);
      
      this.emit('job:completed', { 
        executionId: jobData.execution_id,
        pluginId: jobData.plugin_id,
        functionName: jobData.function_name,
        result,
        executionTime
      });
      
      return {
        success: true,
        result: result,
        execution_time: executionTime,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      const err = error as Error;
      const executionTime = Date.now() - startTime;
      
      console.error(`❌ Plugin execution failed: ${err.message}`);
      
      const errorResult: PluginExecutionResult = {
        success: false,
        error: err.message,
        execution_time: executionTime,
        timestamp: new Date().toISOString()
      };
      
      // Send error result back to LeanEZ
      if (jobData.callback_queue) {
        await this.sendResultToLeanEZ(jobData.execution_id, errorResult, jobData.callback_queue);
      }
      
      this.emit('job:failed', {
        executionId: jobData.execution_id,
        pluginId: jobData.plugin_id,
        functionName: jobData.function_name,
        error: err.message,
        executionTime
      });
      
      return errorResult;
    }
  }

  /**
   * Send execution result back to LeanEZ server
   */
  private async sendResultToLeanEZ(
    executionId: string, 
    result: PluginExecutionResult, 
    callbackQueue: string
  ): Promise<void> {
    try {
      await PubSubIO.emit(`plugin-execution-result-${callbackQueue}`, {
        execution_id: executionId,
        server_id: this.serverId,
        result,
        timestamp: new Date().toISOString()
      }, { sender: this.serverId });
      
      console.log(`📤 Result sent via PubSub: ${executionId}`);
      
    } catch (error) {
      const err = error as Error;
      console.error(`Failed to send result to LeanEZ: ${err.message}`);
      
      try {
        await BullIO.emit({
          name: `plugin-execution-result-${callbackQueue}`,
          data: {
            execution_id: executionId,
            server_id: this.serverId,
            result,
            timestamp: new Date().toISOString()
          },
          handler: (data: any) => {
            console.log('Fallback: Result sent via BullIO:', data);
            return { success: true };
          }
        });
      } catch (fallbackError) {
        console.error('Both PubSub and Bull delivery failed:', fallbackError);
      }
    }
  }

  /**
   * Start local testing server for development
   */
  private async startLocalTestServer(): Promise<void> {
    try {
      this.testServer = new LocalTestServer({
        port: this.config.port,
        pluginsPath: this.config.plugins_path
      });
      await this.testServer.start();
      
    } catch (error) {
      const err = error as Error;
      console.error(`Failed to start local test server: ${err.message}`);
      // Don't throw error, just log it
    }
  }

  /**
   * Get server status
   */
  getStatus() {
    return {
      server_id: this.serverId,
      queue_name: this.queueName,
      is_running: this.isRunning,
      uptime: process.uptime(),
      memory_usage: process.memoryUsage()
    };
  }
} 