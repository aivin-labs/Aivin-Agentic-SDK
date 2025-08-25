import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { LocalTestServer } from './LocalTestServer';
import { LLMIO } from './services/LLMIO';
import { PubSubIO } from './services/PubSubIO';
import {
  PluginExecutionResult,
  PluginManifest,
} from './types/PluginTypes';


// Single method pattern - simplified job data
export interface PluginJobData {
  execution_id?: string; // Optional for direct calls
  plugin_name?: string; // Plugin name for validation (optional)
  data: any; // Input data for the single entry point
  ctx?: {
    user: any;
    workspace: any;
    session: any;
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
// Plugin Server config interface (Single method pattern)
export interface PluginServerConfig {
  server_id?: string;
  enable_local_testing?: boolean;
  port?: number;
  plugins_path?: string;
}

export class PluginServer extends EventEmitter {
  private config: PluginServerConfig;
  private isRunning: boolean = false;
  private serverId: string;
  private testServer: any = null; // LocalTestServer instance
  private plugin: LoadedPlugin | null = null; // Single plugin only

  constructor(config: PluginServerConfig = {}) {
    super();

    this.config = {
      server_id: config.server_id,
      enable_local_testing: config.enable_local_testing ?? false,
      port: config.port || 8080,
      plugins_path: config.plugins_path || '.',
      ...config
    };

    this.serverId = config.server_id || 'temp-server-id';
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
        throw new Error('No plugin loaded. Make sure manifest.json and handler.ts exist.');
      }

      console.log(`✅ Loaded plugin: ${this.plugin.manifest.id} v${this.plugin.manifest.version}`);

      // Set server ID with "node:" prefix and plugin name as identifier
      this.serverId = `node:${this.plugin.manifest.name}`;
      this.config.server_id = this.serverId;

      // Configure LLMIO with plugin name
      LLMIO.configure({ pluginId: this.plugin.manifest.name });

      console.log(`📝 Server ID: ${this.serverId}`);
      console.log(`📝 Plugin Name: ${this.plugin.manifest.name}`);
      console.log(`📝 Plugin ID: ${this.plugin.manifest.id}`);

      // Register plugin with LeanEZ
      await this.registerPlugin();
      console.log('✅ Plugin registered with LeanEZ');

      // Start listening to plugin channel (single method)
      await this.startQueueListener();
      console.log(`✅ Plugin listening on channel: plugin.${this.plugin.manifest.name}`);

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
   * Start listening to plugin execution requests (Single method pattern)
   */
  private async startQueueListener(): Promise<void> {
    // Single method registration - plugin chỉ expose một entry point
    const pluginChannel = `plugin.${this.plugin!.manifest.name}`;

    await PubSubIO.listen(pluginChannel, async (jobData: any) => {
      console.log(`🔄 Received job for plugin: ${this.plugin!.manifest.name}`);

      try {
        const result = await this.executePluginJob(jobData);
        return result;
      } catch (error) {
        const err = error as Error;
        console.error(`❌ Job execution failed: ${err.message}`);
        return {
          success: false,
          error: err.message
        };
      }
    });

    console.log(`🎧 Single method listening on channel: ${pluginChannel}`);
  }

  /**
   * Load single plugin
   */
  private async loadPlugin(): Promise<void> {
    try {
      const pluginsPath = this.config.plugins_path!;
      const manifestPath = path.join(pluginsPath, 'manifest.json');
      const handlerPath = path.join(pluginsPath, 'handler.ts');

      if (!fs.existsSync(manifestPath) || !fs.existsSync(handlerPath)) {
        throw new Error(`Plugin files not found. Expected manifest.json and handler.ts in: ${pluginsPath}`);
      }

      // Load manifest
      const manifestContent = fs.readFileSync(manifestPath, 'utf8');
      const manifest: PluginManifest = JSON.parse(manifestContent);

      // Load handler using dynamic import to support ES modules
      // Convert Windows path to proper file URL
      const absolutePath = path.resolve(handlerPath);
      const importPath = pathToFileURL(absolutePath).href;
      const handlerModule = await eval(`import("${importPath}")`);
      const handler = handlerModule.default || handlerModule;

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

      // Register plugin với single method pattern
      await PubSubIO.emit('plugin-server-register', {
        server_id: this.serverId,
        plugin_channel: `plugin.${plugin.manifest.name}`, // Single channel
        plugin_info: {
          id: plugin.manifest.id,
          name: plugin.manifest.name,
          version: plugin.manifest.version,
          description: plugin.manifest.description,
          author: plugin.manifest.author,
          method: 'single' // Single method pattern - always 'main' entry point
        }
      }, { sender: this.serverId });

      // Single method pattern - không cần register multiple functions

      console.log(`📡 Registered plugin with LeanEZ`);
    } catch (error) {
      const err = error as Error;
      console.error(`❌ Failed to register plugin: ${err.message}`);
    }
  }

  /**
   * Execute plugin job (Single method pattern)
   */
  async executePluginJob(jobData: any): Promise<PluginExecutionResult> {
    try {
      console.log(`🔄 Executing single method for plugin: ${this.plugin!.manifest.name}`);

      // Validate plugin
      if (!this.plugin) {
        throw new Error('No plugin loaded');
      }

      // Single method pattern - always call 'main' or default export
      let targetFunction;

      // Single method pattern - default to 'main' entry point
      const entryPoint = 'main';

      // Try to get specified entry point
      if (this.plugin.handler[entryPoint] && typeof this.plugin.handler[entryPoint] === 'function') {
        targetFunction = this.plugin.handler[entryPoint];
        console.log(`📝 Using entry point: ${entryPoint}`);
      }
      // Fallback to default export if it's a function
      else if (typeof this.plugin.handler === 'function') {
        targetFunction = this.plugin.handler;
        console.log(`📝 Using default export as entry point`);
      }
      // Fallback to any exported function (first one found)
      else {
        const functionNames = Object.keys(this.plugin!.handler).filter(key =>
          typeof this.plugin!.handler[key] === 'function'
        );
        if (functionNames.length > 0) {
          targetFunction = this.plugin.handler[functionNames[0]];
          console.log(`📝 Using function: ${functionNames[0]} as fallback entry point`);
        }
      }

      if (!targetFunction) {
        throw new Error(`No executable function found in plugin ${this.plugin.manifest.name}`);
      }

      // Execute plugin function với input data
      const result = await targetFunction(jobData);

      // Send result back to LeanEZ (nếu có callback)
      if (jobData.callback_queue && jobData.execution_id) {
        await this.sendResultToLeanEZ(jobData.execution_id, {
          success: true,
          result: result
        }, jobData.callback_queue);
      }

      console.log(`✅ Plugin executed successfully`);

      this.emit('job:completed', {
        executionId: jobData.execution_id || 'unknown',
        pluginName: this.plugin!.manifest.name,
        entryPoint: 'main', // Single method pattern
        result
      });

      return {
        success: true,
        result: result
      };

    } catch (error) {
      const err = error as Error;

      console.error(`❌ Plugin execution failed: ${err.message}`);

      const errorResult: PluginExecutionResult = {
        success: false,
        error: err.message
      };

      // Send error result back to LeanEZ
      if (jobData.callback_queue) {
        await this.sendResultToLeanEZ(jobData.execution_id, errorResult, jobData.callback_queue);
      }

      this.emit('job:failed', {
        executionId: jobData.execution_id || 'unknown',
        pluginName: this.plugin!.manifest.name,
        entryPoint: 'main', // Single method pattern
        error: err.message
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
      // Send result via PubSub to LeanEZ server
      await PubSubIO.emit(callbackQueue, {
        execution_id: executionId,
        server_id: this.serverId,
        result
      }, { sender: this.serverId });

      console.log(`✅ Result sent to LeanEZ via queue: ${callbackQueue}`);

    } catch (error) {
      const err = error as Error;
      console.error(`❌ Failed to send result to LeanEZ: ${err.message}`);
      console.error('Make sure PubSub/Redis connection is working properly');

      // Re-throw the error so caller knows delivery failed
      throw new Error(`Failed to deliver result to LeanEZ: ${err.message}`);
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
      plugin_channel: this.plugin ? `plugin.${this.plugin.manifest.name}` : 'none',
      is_running: this.isRunning,
      uptime: process.uptime(),
      memory_usage: process.memoryUsage()
    };
  }
} 