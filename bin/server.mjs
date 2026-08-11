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

    // Real deployed containers never set NODE_ENV=production - verified against the backend's own
    // DockerHelper.createDockerCompose: it writes PLUGIN_ID/SDK_ENDPOINT/SDK_SECRET_FILE/etc, but no
    // NODE_ENV, and the generated Dockerfile has no `ENV NODE_ENV=production` either (`node:24-alpine`
    // doesn't set it, and `npm ci --only=production` only skips devDependencies at install time - it
    // doesn't touch the runtime env var). So NODE_ENV alone can't tell local dev apart from a real
    // container. `SDK_SECRET_FILE` is a much more reliable signal: DockerHelper sets it on every
    // Docker-runtime deploy (bind-mounted `.secrets.env`, see GrpcInvoker.ts's resolveSdkSecret()),
    // and `aivin start` never does - that file/relationship only exists once the platform actually
    // deployed this container. NODE_ENV is kept as a secondary OR in case a future deploy path (or a
    // developer intentionally simulating production locally) does set it.
    const isDeployedContainer = !!process.env.SDK_SECRET_FILE || process.env.NODE_ENV === 'production';
    // One fewer env var to think about: the local HTTP test shim just follows that - on unless this
    // looks like a real deployed container. Set LOCAL_TEST_PORT if you need a specific port (default
    // 4001 - not 3001, which collides with the Aivin backend's own default dev port).
    const enableLocalTesting = !isDeployedContainer;
    const testPort = parseInt(process.env.LOCAL_TEST_PORT || '4001');
    // Loopback-only by default - this shim's /invoke has no auth (see LocalTestServer's class doc).
    // Set LOCAL_TEST_HOST=0.0.0.0 (or a specific interface) only if you deliberately want another
    // device on your network to reach it, e.g. testing from a phone against your dev machine.
    const testHost = process.env.LOCAL_TEST_HOST || '127.0.0.1';

    console.log('Server configuration:');
    console.log(`   Plugin: ${displayName} v${displayVersion}`);
    console.log(`   Plugin directory: ${currentDir}`);
    console.log(`   gRPC bind: ${process.env.SDK_GRPC_SERVER_BIND || '0.0.0.0:50051'}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}${isDeployedContainer ? ' (deployed container)' : ' (local)'}`);
    console.log(
      `   Local test HTTP shim: ${enableLocalTesting ? `enabled on ${testHost}:${testPort}` : 'disabled'}`,
    );

    const pluginServer = new PluginServer({ plugins_path: currentDir });
    const testServer = enableLocalTesting
      ? new LocalTestServer({ port: testPort, host: testHost, pluginsPath: currentDir })
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

    // Hot-reload - local dev only. This same file is also the production container's entrypoint
    // (see the class doc on PluginServer) - `isDeployedContainer` (above) is what actually keeps
    // this off there (source is also bind-mounted read-only in that case, so there's nothing for
    // fs.watch to ever see anyway - this is belt-and-suspenders, not the only thing preventing it).
    // `AIVIN_START_WATCH=false` opts out even in development, e.g. if you'd rather restart by hand.
    const enableWatch = !isDeployedContainer && process.env.AIVIN_START_WATCH !== 'false';
    if (enableWatch) {
      startHotReload(currentDir, pluginServer, testServer);
      console.log('   Hot-reload: watching src/ and manifest.json for changes (AIVIN_START_WATCH=false to disable)');
    }

    console.log('Plugin Server is running! Press Ctrl+C to stop.');
    process.stdin.resume();
  } catch (error) {
    console.error('Failed to start Plugin Server:', error.message);
    process.exit(1);
  }
}

const RELOAD_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']);
const RELOAD_DEBOUNCE_MS = 200;

/**
 * Watches `src/` (recursively) and `manifest.json` (top-level only) for changes and re-imports the
 * plugin in place via `PluginServer.reload()`/`LocalTestServer.reload()` - no more Ctrl+C + restart
 * on every save. Debounced because a single editor save routinely fires several fs events (write +
 * atomic rename, sometimes twice), and would otherwise trigger a burst of redundant reloads.
 *
 * `fs.watch(..., { recursive: true })` isn't supported on every platform/Node build (notably older
 * Linux kernels) - falls back to a non-recursive watch on `src/` itself if it throws, which still
 * catches the common case (a flat `src/main.ts` + `src/service.ts` scaffold) but won't see changes
 * in nested subfolders without a manual restart.
 */
function startHotReload(currentDir, pluginServer, testServer) {
  let debounceTimer;
  const scheduleReload = (reason) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const summary = await pluginServer.reload();
        if (testServer) await testServer.reload();
        console.log(`\n♻️  Reloaded (${reason}): ${summary.id} (${summary.name}) v${summary.version}`);
      } catch (error) {
        console.error(`\n⚠️  Reload failed (${reason}): ${error.message}`);
        console.error('   Still serving the last working version - fix the error and save again.');
      }
    }, RELOAD_DEBOUNCE_MS);
  };

  const onSrcEvent = (_eventType, filename) => {
    if (filename && !RELOAD_EXTENSIONS.has(path.extname(filename))) return;
    scheduleReload(filename ? `src/${filename}` : 'src/');
  };

  const srcDir = path.join(currentDir, 'src');
  try {
    fs.watch(srcDir, { recursive: true }, onSrcEvent);
  } catch {
    try {
      fs.watch(srcDir, { recursive: false }, onSrcEvent);
      console.log('   (recursive watch not supported on this platform - only top-level src/ files are watched)');
    } catch (error) {
      console.log(`   Hot-reload disabled: couldn't watch ${srcDir}: ${error.message}`);
      return;
    }
  }

  // Non-recursive on the plugin root - only care about manifest.json here, not package.json,
  // .env, .test/ reports, etc. that also live at this level.
  fs.watch(currentDir, { recursive: false }, (_eventType, filename) => {
    if (filename === 'manifest.json') scheduleReload('manifest.json');
  });
}

startPluginServer();
