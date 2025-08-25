import * as http from 'http';
import express from 'express';
import { 
    PluginExecutionResult, 
    PluginManifest,
    LogLevel 
} from './types/PluginTypes';

export interface LocalTestServerConfig {
    port?: number;
    pluginsPath?: string;
    logLevel?: LogLevel;
    enableCors?: boolean;
}

/**
 * Local Test Server for Plugin Development
 * 
 * Provides a local HTTP server for testing plugins during development.
 * Mimics the LeanEZ server environment for plugin execution.
 */
export class LocalTestServer {
    private server?: http.Server;
    private app: express.Application;
    private config: Required<LocalTestServerConfig>;

    constructor(config: LocalTestServerConfig = {}) {
        this.config = {
            port: config.port || 3001,
            pluginsPath: config.pluginsPath || '.',
            logLevel: config.logLevel || 'info',
            enableCors: config.enableCors ?? true
        };

        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
    }

    /**
     * Setup Express middleware
     */
    private setupMiddleware(): void {
        // JSON parsing
        this.app.use(express.json({ limit: '10mb' }));

        // CORS
        if (this.config.enableCors) {
            this.app.use((req, res, next) => {
                res.header('Access-Control-Allow-Origin', '*');
                res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
                res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
                
                if (req.method === 'OPTIONS') {
                    res.sendStatus(200);
                } else {
                    next();
                }
            });
        }

        // Request logging
        this.app.use((req, res, next) => {
            this.log('debug', `${req.method} ${req.path}`);
            next();
        });
    }

    /**
     * Setup API routes
     */
    private setupRoutes(): void {
        // Health check
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                version: '1.0.0'
            });
        });

        // List loaded plugins
        this.app.get('/plugins', (req, res) => {
            res.json({
                success: true,
                message: 'Use individual plugin endpoints for testing',
                plugins: [],
                count: 0
            });
        });

        // Execute plugin function
        this.app.post('/plugins/:pluginId/execute', async (req, res) => {
            res.json({
                success: false,
                error: 'Direct plugin execution not supported in simplified mode. Use individual plugin servers instead.'
            });
        });

        // Test plugin (simplified endpoint)
        this.app.post('/test/:pluginId/:functionName', async (req, res) => {
            res.json({
                success: false,
                error: 'Direct plugin testing not supported in simplified mode. Run plugin servers individually.'
            });
        });

        // Error handling
        this.app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
            this.log('error', `Unhandled error: ${error.message}`);
            res.status(500).json({
                success: false,
                error: 'Internal server error'
            });
        });
    }

    /**
     * Start the test server
     */
    async start(): Promise<void> {
        try {
            // Start HTTP server
            this.server = this.app.listen(this.config.port, () => {
                this.log('info', `Local Test Server started on port ${this.config.port}`);
                this.log('info', `Test your plugins at: http://localhost:${this.config.port}`);
            });

            this.server.on('error', (error: Error) => {
                this.log('error', `Server error: ${error.message}`);
            });
        } catch (error) {
            const err = error as Error;
            this.log('error', `Failed to start server: ${err.message}`);
            throw error;
        }
    }

    /**
     * Stop the test server
     */
    async stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this.log('info', 'Local Test Server stopped');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    /**
     * Log message with level
     */
    private log(level: LogLevel, message: string): void {
        const levels = ['debug', 'info', 'warn', 'error'];
        const currentLevel = levels.indexOf(this.config.logLevel);
        const messageLevel = levels.indexOf(level);

        if (messageLevel >= currentLevel) {
            console[level](`[LocalTestServer] ${message}`);
        }
    }
} 