import * as http from 'http';
import { PluginServer } from './PluginServer';
import { PluginIdentity } from './sdk/SDKClient';

export interface LocalTestServerConfig {
  port?: number;
  pluginsPath?: string;
}

/**
 * Local Test Server for plugin development.
 *
 * A tiny dependency-free HTTP shim (no Express) around `PluginServer.testInvoke()`, so a plugin's
 * `main()` can be exercised with plain `curl` during development without needing a gRPC client
 * (e.g. grpcurl) or a running Aivin backend. `ctx.sdk.*` calls still work for real if
 * SDK_GRPC_ENDPOINT/SDK_GRPC_SECRET are pointed at an actual (e.g. local dev) backend.
 */
export class LocalTestServer {
  private readonly port: number;
  private readonly pluginServer: PluginServer;
  private server?: http.Server;

  constructor(config: LocalTestServerConfig = {}) {
    // Not 3000/3001/8080/etc - those collide with almost every other local dev server (including
    // the Aivin backend's own default of 3001) if you're running this alongside one.
    this.port = config.port || 4001;
    this.pluginServer = new PluginServer({ plugins_path: config.pluginsPath });
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve) => {
      this.server!.once('error', (error: NodeJS.ErrnoException) => {
        console.warn(
          `Local Test Server could not start on port ${this.port}: ${error.message} (gRPC server is unaffected)`,
        );
        resolve();
      });
      this.server!.listen(this.port, () => {
        console.log(`Local Test Server started on http://localhost:${this.port}`);
        console.log(
          `  curl -X POST http://localhost:${this.port}/invoke -H 'content-type: application/json' -d '{"input":{}}'`,
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url === '/health') {
      this.sendJson(res, 200, { status: 'healthy', timestamp: new Date().toISOString() });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/invoke') {
      this.sendJson(res, 404, { success: false, error: 'POST /invoke is the only route.' });
      return;
    }

    try {
      const body = await this.readBody(req);
      const {
        mission = 'local-test',
        input = {},
        ctx = {},
      }: { mission?: string; input?: any; ctx?: Partial<PluginIdentity> } = body
        ? JSON.parse(body)
        : {};
      const result = await this.pluginServer.testInvoke(input, ctx, mission);
      this.sendJson(res, 200, { success: true, result });
    } catch (error) {
      const err = error as Error;
      this.sendJson(res, 500, { success: false, error: err.message });
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  private sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
}
