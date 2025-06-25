import axios, { AxiosInstance } from 'axios';
import {
    AutomationConfig,
    JobEntity,
    FlowEntity,
    PluginManifest,
    ExecutionResponse,
    PluginListResponse,
    ApiResponse,
    AutomationError
} from './types';
import { Logger } from './Logger';

export class AutomationClient {
    private http: AxiosInstance;
    private logger: Logger;
    private config: AutomationConfig;

    constructor(config: AutomationConfig) {
        this.config = config;
        this.logger = new Logger(config.debug ? 'debug' : 'info');
        
        // Setup HTTP client
        this.http = axios.create({
            baseURL: config.baseUrl,
            timeout: config.timeout || 30000,
            headers: {
                'Content-Type': 'application/json',
                ...(config.apiKey && { 'Authorization': `Bearer ${config.apiKey}` })
            }
        });

        // Setup interceptors
        this.setupInterceptors();
    }

    /**
     * Setup HTTP interceptors
     */
    private setupInterceptors(): void {
        // Request interceptor
        this.http.interceptors.request.use(
            (config) => {
                this.logger.debug(`HTTP Request: ${config.method?.toUpperCase()} ${config.url}`);
                return config;
            },
            (error) => {
                this.logger.error('HTTP Request Error:', error);
                return Promise.reject(error);
            }
        );

        // Response interceptor
        this.http.interceptors.response.use(
            (response) => {
                this.logger.debug(`HTTP Response: ${response.status} ${response.config.url}`);
                return response;
            },
            (error) => {
                const message = error.response?.data?.message || error.message;
                const statusCode = error.response?.status;
                this.logger.error(`HTTP Error: ${statusCode} - ${message}`);
                
                throw new AutomationError(
                    message,
                    'HTTP_ERROR',
                    statusCode,
                    error.response?.data
                );
            }
        );
    }

    /**
     * Execute automation workflow
     */
    async executeAutomation(
        target: string,
        options: {
            triggerType?: string;
            delay?: number;
            metadata?: any;
        } = {}
    ): Promise<ExecutionResponse> {
        try {
            const response = await this.http.post(
                `/auto/${this.config.workspaceId}/execute`,
                {
                    target,
                    trigger_type: options.triggerType || 'manual',
                    delay: options.delay || 0,
                    metadata: options.metadata
                }
            );

            return response.data;
        } catch (error) {
            this.logger.error('Execute automation failed:', error);
            throw error;
        }
    }

    /**
     * Execute specific plugin
     */
    async executePlugin(
        pluginId: string,
        parameters: any = {}
    ): Promise<ExecutionResponse> {
        try {
            const response = await this.http.post(
                `/auto/${this.config.workspaceId}/execute/plugin/${pluginId}`,
                { params: parameters }
            );

            return response.data;
        } catch (error) {
            this.logger.error(`Execute plugin ${pluginId} failed:`, error);
            throw error;
        }
    }

    /**
     * Get available plugins
     */
    async getPlugins(): Promise<PluginListResponse> {
        try {
            const response = await this.http.get(`/auto/${this.config.workspaceId}/plugins`);
            return response.data;
        } catch (error) {
            this.logger.error('Get plugins failed:', error);
            throw error;
        }
    }

    /**
     * Get specific plugin info
     */
    async getPlugin(pluginId: string): Promise<PluginManifest> {
        try {
            const response = await this.http.get(`/auto/${this.config.workspaceId}/plugins/${pluginId}`);
            return response.data;
        } catch (error) {
            this.logger.error(`Get plugin ${pluginId} failed:`, error);
            throw error;
        }
    }

    /**
     * Cancel plugin jobs
     */
    async cancelPlugin(pluginId: string): Promise<ApiResponse> {
        try {
            const response = await this.http.delete(`/auto/cancel/${this.config.workspaceId}/${pluginId}`);
            return response.data;
        } catch (error) {
            this.logger.error(`Cancel plugin ${pluginId} failed:`, error);
            throw error;
        }
    }

    /**
     * Get job details
     */
    async getJob(jobId: string): Promise<JobEntity> {
        try {
            const response = await this.http.get(`/auto/${this.config.workspaceId}/jobs/${jobId}`);
            return response.data;
        } catch (error) {
            this.logger.error(`Get job ${jobId} failed:`, error);
            throw error;
        }
    }

    /**
     * Get flow details
     */
    async getFlow(flowId: string): Promise<FlowEntity> {
        try {
            const response = await this.http.get(`/auto/${this.config.workspaceId}/flows/${flowId}`);
            return response.data;
        } catch (error) {
            this.logger.error(`Get flow ${flowId} failed:`, error);
            throw error;
        }
    }

    /**
     * List jobs in workspace
     */
    async listJobs(filters: {
        status?: string;
        plugin_id?: string;
        limit?: number;
        offset?: number;
    } = {}): Promise<{ jobs: JobEntity[]; total: number }> {
        try {
            const params = new URLSearchParams();
            Object.entries(filters).forEach(([key, value]) => {
                if (value !== undefined) {
                    params.append(key, value.toString());
                }
            });

            const response = await this.http.get(
                `/auto/${this.config.workspaceId}/jobs?${params.toString()}`
            );
            return response.data;
        } catch (error) {
            this.logger.error('List jobs failed:', error);
            throw error;
        }
    }

    /**
     * List flows in workspace
     */
    async listFlows(filters: {
        status?: string;
        trigger_type?: string;
        limit?: number;
        offset?: number;
    } = {}): Promise<{ flows: FlowEntity[]; total: number }> {
        try {
            const params = new URLSearchParams();
            Object.entries(filters).forEach(([key, value]) => {
                if (value !== undefined) {
                    params.append(key, value.toString());
                }
            });

            const response = await this.http.get(
                `/auto/${this.config.workspaceId}/flows?${params.toString()}`
            );
            return response.data;
        } catch (error) {
            this.logger.error('List flows failed:', error);
            throw error;
        }
    }

    /**
     * Health check
     */
    async health(): Promise<{ status: string; timestamp: string }> {
        try {
            const response = await this.http.get('/health');
            return response.data;
        } catch (error) {
            this.logger.error('Health check failed:', error);
            throw error;
        }
    }

    /**
     * Get client configuration
     */
    getConfig(): AutomationConfig {
        return { ...this.config };
    }

    /**
     * Update client configuration
     */
    updateConfig(updates: Partial<AutomationConfig>): void {
        this.config = { ...this.config, ...updates };
        
        // Update HTTP client if needed
        if (updates.baseUrl || updates.apiKey || updates.timeout) {
            this.http.defaults.baseURL = this.config.baseUrl;
            this.http.defaults.timeout = this.config.timeout || 30000;
            
            if (this.config.apiKey) {
                this.http.defaults.headers['Authorization'] = `Bearer ${this.config.apiKey}`;
            }
        }

        // Update logger level
        if (updates.debug !== undefined) {
            this.logger.setLevel(updates.debug ? 'debug' : 'info');
        }
    }
} 