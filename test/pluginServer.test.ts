import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { PluginServer } from '../src/PluginServer';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'echo-plugin');

// Non-sandboxed path (AIVIN_SANDBOX_WORKER unset) - proves `pluginLoader.ts`'s extraction out of
// `PluginServer` (done alongside the worker-sandbox addition) didn't change behavior. No real
// gRPC/network involved: `testInvoke()` runs the fixture in-process, same as `aivin start`'s local
// HTTP test shim does. Deliberately avoids the fixture's `action: 'echo'` case here (it calls
// `ctx.sdk.call()`, which - unlike the sandboxed `PluginWorkerHost` path - has no injectable
// transport on `PluginServer` itself and would dial the real backend; `sdkClient.test.ts` already
// covers `ctx.sdk.call()` in isolation with a fake transport).

test('testInvoke() loads and runs the fixture plugin directly, no sandbox', async () => {
  assert.equal(process.env.AIVIN_SANDBOX_WORKER, undefined);
  const server = new PluginServer({ plugins_path: FIXTURE_PATH });
  const result = await server.testInvoke({ ok: true }, {}, 'my-mission');
  assert.deepEqual(result, { mission: 'my-mission', input: { ok: true } });
});

test('testInvoke() surfaces a thrown plugin error as a rejection', async () => {
  const server = new PluginServer({ plugins_path: FIXTURE_PATH });
  await assert.rejects(
    server.testInvoke({ action: 'throw', payload: 'boom' }, {}),
    /deliberate fixture failure: boom/,
  );
});

test('testInvoke() runs a plugin that calls console.log without crashing', async () => {
  const server = new PluginServer({ plugins_path: FIXTURE_PATH });
  const result = await server.testInvoke({ action: 'log' }, {});
  assert.equal(result, 'logged');
});

test('getStatus() reports the loaded plugin summary once testInvoke has run', async () => {
  const server = new PluginServer({ plugins_path: FIXTURE_PATH });
  await server.testInvoke({ action: 'log' }, {});
  const status = server.getStatus();
  assert.equal(status.plugin_id, 'echo-plugin-fixture');
  assert.equal(status.plugin_name, 'echo-plugin-fixture');
});

test('reload() re-imports the plugin and it keeps working (non-sandboxed cache-busting path)', async () => {
  const server = new PluginServer({ plugins_path: FIXTURE_PATH });
  await server.testInvoke({ action: 'log' }, {});
  const summary = await server.reload();
  assert.equal(summary.id, 'echo-plugin-fixture');
  const result = await server.testInvoke({}, {}, 'still-alive-mission');
  assert.deepEqual(result, { mission: 'still-alive-mission', input: {} });
});
