import * as http from 'http';
import { PluginServer } from './PluginServer';
import { PluginIdentity } from './sdk/SDKClient';

export interface LocalTestServerConfig {
  port?: number;
  /** Interface to bind to. Defaults to `127.0.0.1` - deliberately loopback-only, see the class
   *  doc's security note. Pass `0.0.0.0` (or any other interface) only if you specifically need
   *  another device on your network to reach this, and understand the tradeoff. */
  host?: string;
  pluginsPath?: string;
}

/**
 * Local Test Server for plugin development.
 *
 * A tiny dependency-free HTTP shim (no Express) around `PluginServer.testInvoke()`, so a plugin's
 * `main()` can be exercised with plain `curl` during development without needing a gRPC client
 * (e.g. grpcurl) or a running Aivin backend. `ctx.sdk.*` calls still work for real if
 * SDK_ENDPOINT/SDK_SECRET are pointed at an actual (e.g. local dev) backend.
 *
 * SECURITY: `/invoke` has no auth - the caller freely picks `mission`/`input`/`ctx` (including
 * `ctx.metadata._cap`, which becomes the capability token used for any outbound `ctx.sdk.*` call
 * this triggers). That's fine for its intended use (you, on your own machine, driving it with
 * curl/scripts) but would let anyone else who can reach this port impersonate whatever
 * tenant/workspace they put in `ctx` - and if SDK_ENDPOINT/SDK_SECRET point at a real backend,
 * that impersonation is backed by this container's real secret. Two independent guards against
 * that: bound to loopback only by default (below), and cross-origin browser requests are rejected
 * (see `isAllowedOrigin` - closes the "malicious webpage does `fetch('http://localhost:4001/...')`"
 * hole that loopback-binding alone doesn't, since the browser making the request is itself local).
 */
export class LocalTestServer {
  private readonly port: number;
  private readonly host: string;
  private readonly pluginServer: PluginServer;
  private server?: http.Server;

  constructor(config: LocalTestServerConfig = {}) {
    // Not 3000/3001/8080/etc - those collide with almost every other local dev server (including
    // the Aivin backend's own default of 3001) if you're running this alongside one.
    this.port = config.port || 4001;
    this.host = config.host || '127.0.0.1';
    this.pluginServer = new PluginServer({ plugins_path: config.pluginsPath });
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve) => {
      this.server!.once('error', (error: NodeJS.ErrnoException) => {
        console.warn(
          `Local Test Server could not start on ${this.host}:${this.port}: ${error.message} (gRPC server is unaffected)`,
        );
        resolve();
      });
      this.server!.listen(this.port, this.host, () => {
        console.log(`Local Test Server started on http://${this.host}:${this.port}`);
        if (this.host !== '127.0.0.1' && this.host !== 'localhost') {
          console.warn(
            `  ⚠️  Bound to ${this.host}, not loopback-only - /invoke has no auth and accepts a caller-chosen ctx (including the identity used for any real ctx.sdk.* call it makes). Only do this on a network you trust.`,
          );
        }
        console.log(
          `  curl -X POST http://${this.host === '0.0.0.0' ? 'localhost' : this.host}:${this.port}/invoke -H 'content-type: application/json' -d '{"input":{}}'`,
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  /** Passthrough to the internal `PluginServer.reload()` - see there for hot-reload semantics.
   *  `aivin start`'s file-watcher calls this alongside the real gRPC `PluginServer`'s own
   *  `reload()` so a `curl`-tested change and a real-host-triggered one never disagree. */
  reload(): Promise<{ id: string; name: string; version: string }> {
    return this.pluginServer.reload();
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

    if (!this.isAllowedOrigin(req.headers.origin)) {
      this.sendJson(res, 403, {
        success: false,
        error: `Cross-origin requests are not allowed (Origin: ${req.headers.origin}). This endpoint has no auth and is meant to be called from a local terminal/script, not a browser page.`,
      });
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

  /**
   * A request with no `Origin` header (curl, node scripts, grpcurl-style tools) is always allowed -
   * that's the intended caller. A request that DOES carry `Origin` came from a browser context;
   * only accept it if it's this same server (guards against a malicious page the developer has
   * open in a tab making a same-machine `fetch()` here - loopback binding alone doesn't stop that,
   * since the browser itself is already "local").
   */
  private isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return true;
    return origin === `http://localhost:${this.port}` || origin === `http://127.0.0.1:${this.port}`;
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
