import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockSDK, withMockSDK, createMockContext } from '../src/sdk/testUtils';
import { getCurrentSDK } from '../src/sdk/currentInvocation';

test('createMockSDK() routes a call through its handler and records it in `calls`', async () => {
  const { client, calls } = createMockSDK({
    handlers: { 'ai.prompt': async ({ quest }) => `Echo: ${quest}` },
  });

  const result = await client.ai.prompt('hello');

  assert.equal(result, 'Echo: hello');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].namespace, 'ai.prompt');
});

test('createMockSDK() throws a clear error for a namespace with no registered handler', async () => {
  const { client } = createMockSDK({ handlers: { 'ai.prompt': async () => 'x' } });

  await assert.rejects(
    async () => {
      await client.store.get('orders', 'o1');
    },
    /no handler registered.*store\.get.*ai\.prompt/s,
  );
});

test('createMockSDK() applies identity overrides and defaults the rest', async () => {
  const { client } = createMockSDK({ identity: { client: 'acme-corp' } });
  // `config` reads straight off the identity - a light way to assert defaults/overrides landed
  // without reaching into private state.
  assert.deepEqual(client.config, {});
});

test('withMockSDK() binds the mock so the top-level `ai`/`store`/etc imports resolve to it', async () => {
  const { client, calls } = createMockSDK({
    handlers: { 'ai.prompt': async () => 'from top-level import' },
  });

  const result = await withMockSDK(client, async () => {
    // Simulates what `import { ai } from '@aivin-labs/sdk'` resolves to inside main() - going
    // through getCurrentSDK() directly here to avoid a circular import in the test itself.
    return getCurrentSDK().ai.prompt('anything');
  });

  assert.equal(result, 'from top-level import');
  assert.equal(calls[0].namespace, 'ai.prompt');
});

test('withMockSDK() isolates concurrent calls from each other', async () => {
  const a = createMockSDK({ handlers: { 'ai.prompt': async () => 'A' } });
  const b = createMockSDK({ handlers: { 'ai.prompt': async () => 'B' } });

  const [resultA, resultB] = await Promise.all([
    withMockSDK(a.client, () => getCurrentSDK().ai.prompt('x')),
    withMockSDK(b.client, () => getCurrentSDK().ai.prompt('x')),
  ]);

  assert.equal(resultA, 'A');
  assert.equal(resultB, 'B');
});

test('createMockContext() builds a ctx with the given client plus plausible defaults', () => {
  const { client } = createMockSDK();
  const ctx = createMockContext(client);

  assert.equal(ctx.sdk, client);
  assert.equal(ctx.user?.id, 'test-user');
  assert.equal(ctx.workspace?.id, 'test-workspace');
});

test('createMockContext() lets overrides win over the defaults', () => {
  const { client } = createMockSDK();
  const ctx = createMockContext(client, { user: { id: 'custom-user' } as any });

  assert.equal(ctx.user?.id, 'custom-user');
});
