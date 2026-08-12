import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// Imports the COMPILED output, not `../src/worker/PluginWorkerHost` - `PluginWorkerHost` spawns
// `worker_threads.Worker(path.join(__dirname, 'PluginWorkerRuntime.js'))`, a real sibling-file
// lookup that only resolves once `npm run build` has produced `dist/worker/*.js`. Requires a
// fresh build before running this file - same as any test exercising real Worker-spawning code
// would need in any Node project structured this way.
import { PluginWorkerHost } from '../dist/worker/PluginWorkerHost';
import type { InvokeRequest } from '../src/grpc/GrpcInvoker';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'echo-plugin');

/** Fake `ctx.sdk.*` transport - proves the relay round-trip works without a real backend. Mirrors
 *  `test/sdkClient.test.ts`'s injectable-transport pattern. */
function fakeInvoke(request: InvokeRequest): Promise<any> {
  if (request.namespace === 'test.echo') return Promise.resolve(request.params);
  return Promise.reject(new Error(`fakeInvoke: unexpected namespace ${request.namespace}`));
}

function makeHost(overrides: Partial<{ invoke: typeof fakeInvoke }> = {}) {
  return new PluginWorkerHost({
    pluginsPath: FIXTURE_PATH,
    invoke: overrides.invoke ?? fakeInvoke,
  });
}

test('start() loads the fixture plugin and reports its manifest summary', async () => {
  const host = makeHost();
  try {
    const summary = await host.start();
    assert.equal(summary.id, 'echo-plugin-fixture');
    assert.equal(summary.name, 'echo-plugin-fixture');
    assert.deepEqual(host.getSummary(), summary);
  } finally {
    await host.stop();
  }
});

test('a ctx.sdk.call() made inside the sandboxed plugin relays through the host to the real transport', async () => {
  const host = makeHost();
  try {
    const result = await host.invokePlugin('t', { action: 'echo', payload: { x: 1, y: 'two' } }, {});
    assert.deepEqual(result, { x: 1, y: 'two' });
  } finally {
    await host.stop();
  }
});

test('SECURITY: the sandboxed plugin cannot fs.readFileSync a path outside its own project directory', async () => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-sandbox-test-'));
  const outsideFile = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outsideFile, 'super-secret-value');

  const host = makeHost();
  try {
    const result = await host.invokePlugin('t', { action: 'readFile', path: outsideFile }, {});
    assert.equal(result.blocked, true, `expected the read to be blocked, got: ${JSON.stringify(result)}`);
    assert.equal(result.code, 'ERR_ACCESS_DENIED');
  } finally {
    await host.stop();
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('the sandboxed plugin CAN fs.readFileSync a path inside its own project directory', async () => {
  const host = makeHost();
  try {
    const manifestPath = path.join(FIXTURE_PATH, 'manifest.json');
    const result = await host.invokePlugin('t', { action: 'readFile', path: manifestPath }, {});
    assert.equal(result.blocked, false);
    assert.match(result.content, /echo-plugin-fixture/);
  } finally {
    await host.stop();
  }
});

test('SECURITY: the sandboxed plugin cannot spawn a child process', async () => {
  const host = makeHost();
  try {
    const result = await host.invokePlugin('t', { action: 'spawnChild' }, {});
    assert.equal(result.blocked, true, `expected child_process to be blocked, got: ${JSON.stringify(result)}`);
  } finally {
    await host.stop();
  }
});

test('console.log/error inside the sandboxed plugin does not crash the invocation', async () => {
  const host = makeHost();
  try {
    const result = await host.invokePlugin('t', { action: 'log' }, {});
    assert.equal(result, 'logged');
  } finally {
    await host.stop();
  }
});

test('a thrown error inside the sandboxed plugin rejects invokePlugin() with the same message', async () => {
  const host = makeHost();
  try {
    await assert.rejects(
      host.invokePlugin('t', { action: 'throw', payload: 'boom' }, {}),
      /deliberate fixture failure: boom/,
    );
  } finally {
    await host.stop();
  }
});

test('concurrent invocations on the same worker do not cross-contaminate results', async () => {
  const host = makeHost();
  try {
    const [a, b, c] = await Promise.all([
      host.invokePlugin('t', { action: 'echo', payload: { id: 'a' } }, {}),
      host.invokePlugin('t', { action: 'echo', payload: { id: 'b' } }, {}),
      host.invokePlugin('t', { action: 'echo', payload: { id: 'c' } }, {}),
    ]);
    assert.deepEqual(a, { id: 'a' });
    assert.deepEqual(b, { id: 'b' });
    assert.deepEqual(c, { id: 'c' });
  } finally {
    await host.stop();
  }
});

test('reload() respawns the worker and it keeps working afterward', async () => {
  const host = makeHost();
  try {
    await host.start();
    const summary = await host.reload();
    assert.equal(summary.id, 'echo-plugin-fixture');
    const result = await host.invokePlugin('t', { action: 'echo', payload: 'still alive' }, {});
    assert.equal(result, 'still alive');
  } finally {
    await host.stop();
  }
});

test('start() rejects when the plugin directory has no manifest.json/src/main.ts', async () => {
  const host = new PluginWorkerHost({
    pluginsPath: path.join(__dirname, 'fixtures', 'does-not-exist'),
    invoke: fakeInvoke,
  });
  await assert.rejects(host.start());
  await host.stop();
});
