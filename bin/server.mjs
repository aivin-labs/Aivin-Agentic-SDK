#!/usr/bin/env node

import { PluginServer } from '../dist/PluginServer.js';
import { LocalTestServer } from '../dist/LocalTestServer.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import dotenv from 'dotenv';

// Load `.env` from the current directory (the plugin project) first, then `~/.aivin/credentials`
// (written by `aivin login`) as a fallback for API_KEY - same precedence as bin/cli.mjs. `quiet`
// suppresses dotenv's stdout "tip" line, which would otherwise mix into this server's own logging.
dotenv.config({ quiet: true });
const globalCredentialsPath = path.join(os.homedir(), '.aivin', 'credentials');
if (fs.existsSync(globalCredentialsPath)) {
  dotenv.config({ path: globalCredentialsPath, quiet: true });
}

/**
 * Plugin Server Entry Point
 * Starts the gRPC server the Aivin host calls into (see PluginRunner.handleDockerRuntime on the
 * backend) to trigger this plugin's `main()`. Bound on port 50051 inside the plugin's container.
 */
async function startPluginServer() {
  try {
    console.log('Starting Aivin Plugin Server...');

    const currentDir = process.cwd();
    const manifestPath = path.join(currentDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        'manifest.json not found in current directory. Please run this command in your plugin directory.',
      );
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // The default manifest shape is { ...sharedFields, plugins: [...] } - name lives on the
    // entries there; the legacy flat single-object shape has it at the top level.
    const entries = Array.isArray(manifest.plugins) ? manifest.plugins : [manifest];
    const displayName = entries.map((e) => e.name).filter(Boolean).join(', ') || '(unnamed)';
    const displayVersion = manifest.version || entries[0]?.version || '0.0.0';

    // One fewer env var to think about: the local HTTP test shim just follows NODE_ENV - on unless
    // you're in production. Set LOCAL_TEST_PORT if you need a specific port (default 4001 - not
    // 3001, which collides with the Aivin backend's own default dev port).
    const enableLocalTesting = process.env.NODE_ENV !== 'production';
    const testPort = parseInt(process.env.LOCAL_TEST_PORT || '4001');

    console.log('Server configuration:');
    console.log(`   Plugin: ${displayName} v${displayVersion}`);
    console.log(`   Plugin directory: ${currentDir}`);
    console.log(`   gRPC bind: ${process.env.SDK_GRPC_SERVER_BIND || '0.0.0.0:50051'}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(
      `   Local test HTTP shim: ${enableLocalTesting ? `enabled on port ${testPort}` : 'disabled'}`,
    );

    const pluginServer = new PluginServer({ plugins_path: currentDir });
    const testServer = enableLocalTesting
      ? new LocalTestServer({ port: testPort, pluginsPath: currentDir })
      : null;

    const shutdown = async (signal) => {
      console.log(`\nReceived ${signal}, shutting down...`);
      try {
        if (testServer) await testServer.stop();
        await pluginServer.stop();
        process.exit(0);
      } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
      }
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    await pluginServer.start();
    if (testServer) await testServer.start();

    console.log('Plugin Server is running! Press Ctrl+C to stop.');
    process.stdin.resume();
  } catch (error) {
    console.error('Failed to start Plugin Server:', error.message);
    process.exit(1);
  }
}

startPluginServer();
