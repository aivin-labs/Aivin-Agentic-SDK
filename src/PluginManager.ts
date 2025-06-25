import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

export interface PluginSecurityConfig {
  maxMemory: string;
  maxCpus: string;
  maxProcesses: number;
  allowedNetworks: string[];
  allowedVolumes: string[];
  readOnlyRootFilesystem: boolean;
  noNewPrivileges: boolean;
  dropCapabilities: string[];
  addCapabilities: string[];
}

export interface ManagedPlugin {
  id: string;
  name: string;
  version: string;
  containerId: string;
  status: 'starting' | 'running' | 'stopped' | 'error';
  securityConfig: PluginSecurityConfig;
  createdAt: Date;
  lastHealthCheck: Date;
  resourceUsage: {
    memory: number;
    cpu: number;
    network: number;
  };
}

/**
 * Plugin Manager - Secure container orchestration for plugins
 */
export class PluginManager extends EventEmitter {
  private plugins: Map<string, ManagedPlugin> = new Map();
  private redisUrl: string;
  private networkName: string = 'plugin-network';
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(redisUrl: string) {
    super();
    this.redisUrl = redisUrl;
  }

  /**
   * Start Plugin Manager
   */
  async start(): Promise<void> {
    console.log('🚀 Starting Plugin Manager...');
    
    // Ensure plugin network exists
    await this.ensurePluginNetwork();
    
    // Start health monitoring
    this.startHealthMonitoring();
    
    // Load existing plugins
    await this.loadExistingPlugins();
    
    console.log('✅ Plugin Manager started');
  }

  /**
   * Deploy a new plugin securely
   */
  async deployPlugin(
    pluginPath: string, 
    securityConfig?: Partial<PluginSecurityConfig>
  ): Promise<string> {
    const manifest = await this.loadPluginManifest(pluginPath);
    const pluginId = manifest.id || manifest.name;

    console.log(`📦 Deploying plugin: ${pluginId}`);

    // Generate security config
    const security = this.generateSecurityConfig(manifest, securityConfig);

    // Build plugin container
    const imageTag = await this.buildPluginContainer(pluginPath, pluginId);

    // Create and start container
    const containerId = await this.createPluginContainer(pluginId, imageTag, security);

    // Register plugin
    const plugin: ManagedPlugin = {
      id: pluginId,
      name: manifest.name,
      version: manifest.version,
      containerId,
      status: 'starting',
      securityConfig: security,
      createdAt: new Date(),
      lastHealthCheck: new Date(),
      resourceUsage: { memory: 0, cpu: 0, network: 0 }
    };

    this.plugins.set(pluginId, plugin);

    // Start container
    await this.startPluginContainer(containerId);
    plugin.status = 'running';

    console.log(`✅ Plugin deployed: ${pluginId} (${containerId.slice(0, 12)})`);
    this.emit('plugin:deployed', plugin);

    return pluginId;
  }

  /**
   * Stop and remove plugin
   */
  async removePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }

    console.log(`🗑️ Removing plugin: ${pluginId}`);

    // Stop container
    await this.stopPluginContainer(plugin.containerId);

    // Remove container
    await this.removePluginContainer(plugin.containerId);

    // Remove from registry
    this.plugins.delete(pluginId);

    console.log(`✅ Plugin removed: ${pluginId}`);
    this.emit('plugin:removed', plugin);
  }

  /**
   * Get plugin status
   */
  getPluginStatus(pluginId: string): ManagedPlugin | null {
    return this.plugins.get(pluginId) || null;
  }

  /**
   * List all plugins
   */
  listPlugins(): ManagedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Generate security configuration
   */
  private generateSecurityConfig(
    manifest: any, 
    overrides?: Partial<PluginSecurityConfig>
  ): PluginSecurityConfig {
    const defaultConfig: PluginSecurityConfig = {
      maxMemory: '128M',
      maxCpus: '0.2',
      maxProcesses: 50,
      allowedNetworks: [this.networkName],
      allowedVolumes: [`${manifest.id}-data`, `${manifest.id}-logs`],
      readOnlyRootFilesystem: false,
      noNewPrivileges: true,
      dropCapabilities: ['ALL'],
      addCapabilities: []
    };

    // Apply security rules based on plugin capabilities
    if (manifest.capabilities?.includes('network')) {
      defaultConfig.addCapabilities.push('NET_BIND_SERVICE');
    }

    if (manifest.capabilities?.includes('high-memory')) {
      defaultConfig.maxMemory = '256M';
    }

    if (manifest.capabilities?.includes('high-cpu')) {
      defaultConfig.maxCpus = '0.5';
    }

    return { ...defaultConfig, ...overrides };
  }

  /**
   * Build plugin container
   */
  private async buildPluginContainer(pluginPath: string, pluginId: string): Promise<string> {
    const imageTag = `leanez-plugin-${pluginId}:latest`;
    const dockerfilePath = path.join(__dirname, '../docker/Dockerfile.plugin');

    const buildCommand = `docker build -t ${imageTag} -f ${dockerfilePath} ${pluginPath}`;
    
    try {
      await execAsync(buildCommand);
      console.log(`✅ Built container image: ${imageTag}`);
      return imageTag;
    } catch (error) {
      console.error(`❌ Failed to build plugin container: ${error}`);
      throw error;
    }
  }

  /**
   * Create plugin container with security constraints
   */
  private async createPluginContainer(
    pluginId: string, 
    imageTag: string, 
    security: PluginSecurityConfig
  ): Promise<string> {
    const containerName = `leanez-plugin-${pluginId}`;
    
    const createCommand = [
      'docker create',
      `--name ${containerName}`,
      `--network ${this.networkName}`,
      `--memory ${security.maxMemory}`,
      `--cpus ${security.maxCpus}`,
      `--pids-limit ${security.maxProcesses}`,
      '--security-opt no-new-privileges:true',
      '--cap-drop ALL',
      ...security.addCapabilities.map(cap => `--cap-add ${cap}`),
      `--env PLUGIN_ID=${pluginId}`,
      `--env PLUGIN_REDIS_URL=${this.redisUrl}`,
      '--tmpfs /tmp:size=50M,mode=1777,noexec,nosuid,nodev',
      '--ulimit nproc=50:50',
      '--ulimit nofile=1024:1024',
      `--volume ${pluginId}-data:/app/data:rw`,
      `--volume ${pluginId}-logs:/app/logs:rw`,
      '--restart unless-stopped',
      imageTag
    ].join(' ');

    try {
      const { stdout } = await execAsync(createCommand);
      const containerId = stdout.trim();
      console.log(`✅ Created container: ${containerId.slice(0, 12)}`);
      return containerId;
    } catch (error) {
      console.error(`❌ Failed to create plugin container: ${error}`);
      throw error;
    }
  }

  /**
   * Start plugin container
   */
  private async startPluginContainer(containerId: string): Promise<void> {
    try {
      await execAsync(`docker start ${containerId}`);
      console.log(`✅ Started container: ${containerId.slice(0, 12)}`);
    } catch (error) {
      console.error(`❌ Failed to start container: ${error}`);
      throw error;
    }
  }

  /**
   * Stop plugin container
   */
  private async stopPluginContainer(containerId: string): Promise<void> {
    try {
      await execAsync(`docker stop ${containerId}`);
      console.log(`✅ Stopped container: ${containerId.slice(0, 12)}`);
    } catch (error) {
      console.error(`❌ Failed to stop container: ${error}`);
      throw error;
    }
  }

  /**
   * Remove plugin container
   */
  private async removePluginContainer(containerId: string): Promise<void> {
    try {
      await execAsync(`docker rm ${containerId}`);
      console.log(`✅ Removed container: ${containerId.slice(0, 12)}`);
    } catch (error) {
      console.error(`❌ Failed to remove container: ${error}`);
      throw error;
    }
  }

  /**
   * Ensure plugin network exists
   */
  private async ensurePluginNetwork(): Promise<void> {
    try {
      await execAsync(`docker network inspect ${this.networkName}`);
      console.log(`✅ Plugin network exists: ${this.networkName}`);
    } catch (error) {
      // Network doesn't exist, create it
      try {
        await execAsync(`docker network create --driver bridge ${this.networkName}`);
        console.log(`✅ Created plugin network: ${this.networkName}`);
      } catch (createError) {
        console.error(`❌ Failed to create plugin network: ${createError}`);
        throw createError;
      }
    }
  }

  /**
   * Load plugin manifest
   */
  private async loadPluginManifest(pluginPath: string): Promise<any> {
    const manifestPath = path.join(pluginPath, 'manifest.json');
    const manifestContent = await fs.promises.readFile(manifestPath, 'utf-8');
    return JSON.parse(manifestContent);
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      for (const plugin of this.plugins.values()) {
        await this.checkPluginHealth(plugin);
      }
    }, 30000); // Check every 30 seconds
  }

  /**
   * Check plugin health
   */
  private async checkPluginHealth(plugin: ManagedPlugin): Promise<void> {
    try {
      // Check container status
      const { stdout } = await execAsync(`docker inspect ${plugin.containerId} --format='{{.State.Status}}'`);
      const status = stdout.trim();

      if (status === 'running') {
        plugin.status = 'running';
        plugin.lastHealthCheck = new Date();

        // Get resource usage
        const statsCommand = `docker stats ${plugin.containerId} --no-stream --format "table {{.MemUsage}}\t{{.CPUPerc}}\t{{.NetIO}}"`;
        const { stdout: statsOutput } = await execAsync(statsCommand);
        
        // Parse stats (simplified)
        const lines = statsOutput.split('\n');
        if (lines.length > 1) {
          const stats = lines[1].split('\t');
          plugin.resourceUsage = {
            memory: this.parseMemoryUsage(stats[0]),
            cpu: this.parseCpuUsage(stats[1]),
            network: this.parseNetworkUsage(stats[2])
          };
        }
      } else {
        plugin.status = 'error';
        console.warn(`⚠️ Plugin container unhealthy: ${plugin.id} (${status})`);
        this.emit('plugin:unhealthy', plugin);
      }
    } catch (error) {
      plugin.status = 'error';
      console.error(`❌ Health check failed for plugin ${plugin.id}:`, error);
      this.emit('plugin:error', plugin, error);
    }
  }

  /**
   * Load existing plugins on startup
   */
  private async loadExistingPlugins(): Promise<void> {
    try {
      const { stdout } = await execAsync('docker ps -a --filter "name=leanez-plugin-" --format "{{.Names}}\t{{.ID}}\t{{.Status}}"');
      const lines = stdout.trim().split('\n').filter(line => line);

      for (const line of lines) {
        const [name, containerId, status] = line.split('\t');
        const pluginId = name.replace('leanez-plugin-', '');

        // Basic plugin info (would need to be enhanced with proper metadata storage)
        const plugin: ManagedPlugin = {
          id: pluginId,
          name: pluginId,
          version: 'unknown',
          containerId,
          status: status.includes('Up') ? 'running' : 'stopped',
          securityConfig: this.generateSecurityConfig({}),
          createdAt: new Date(),
          lastHealthCheck: new Date(),
          resourceUsage: { memory: 0, cpu: 0, network: 0 }
        };

        this.plugins.set(pluginId, plugin);
        console.log(`📋 Loaded existing plugin: ${pluginId}`);
      }
    } catch (error) {
      console.log('ℹ️ No existing plugins found');
    }
  }

  /**
   * Utility methods for parsing resource usage
   */
  private parseMemoryUsage(memString: string): number {
    // Parse "123.4MiB / 128MiB" format
    const match = memString.match(/^([\d.]+)(\w+)/);
    if (match) {
      const value = parseFloat(match[1]);
      const unit = match[2];
      return unit === 'MiB' ? value : value / 1024; // Convert to MiB
    }
    return 0;
  }

  private parseCpuUsage(cpuString: string): number {
    // Parse "12.34%" format
    return parseFloat(cpuString.replace('%', '')) || 0;
  }

  private parseNetworkUsage(netString: string): number {
    // Parse "1.23MB / 456kB" format
    const parts = netString.split(' / ');
    if (parts.length > 0) {
      const match = parts[0].match(/^([\d.]+)(\w+)/);
      if (match) {
        const value = parseFloat(match[1]);
        const unit = match[2];
        return unit === 'MB' ? value * 1024 : value; // Convert to kB
      }
    }
    return 0;
  }

  /**
   * Cleanup on shutdown
   */
  async stop(): Promise<void> {
    console.log('🛑 Stopping Plugin Manager...');
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Optionally stop all managed plugins
    for (const plugin of this.plugins.values()) {
      if (plugin.status === 'running') {
        await this.stopPluginContainer(plugin.containerId);
      }
    }

    console.log('✅ Plugin Manager stopped');
  }
} 