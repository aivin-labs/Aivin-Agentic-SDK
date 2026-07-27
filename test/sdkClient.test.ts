import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SDKClient, looksLikeAgentId, type PluginIdentity } from '../src/sdk/SDKClient';
import type { InvokeRequest, StreamHandle } from '../src/grpc/GrpcInvoker';

function makeClient(
  invoke: (request: InvokeRequest) => Promise<any>,
  context: Partial<PluginIdentity> = {},
) {
  const identity: PluginIdentity = {
    user: { id: 'u1' } as any,
    workspace: { id: 'w1' } as any,
    session: {} as any,
    org_id: 'org1',
    client: 'test',
    config: { foo: 'bar' },
    metadata: { trace: 'abc' },
    ...context,
  } as PluginIdentity;
  return new SDKClient(identity, { cap: 'cap-token', invoke });
}

/** Fake StreamHandle backing a promptStream() test - yields `deltas` then resolves `final` to
 *  their concatenation, without touching the real gRPC transport. */
function fakeStreamHandle(deltas: string[]): StreamHandle<string> {
  async function* chunks(): AsyncGenerator<string, void, void> {
    for (const d of deltas) yield d;
  }
  return { chunks: chunks(), final: Promise.resolve(deltas.join('')) };
}

function makeStreamingClient(invokeStream: (request: InvokeRequest) => StreamHandle<any>) {
  const identity: PluginIdentity = {
    user: { id: 'u1' } as any,
    workspace: { id: 'w1' } as any,
    session: {} as any,
    org_id: 'org1',
    client: 'test',
    config: {},
    metadata: {},
  } as PluginIdentity;
  return new SDKClient(identity, { cap: 'cap-token', invoke: async () => ({}), invokeStream });
}

test('looksLikeAgentId accepts short hex/UUID-like strings, rejects natural language', () => {
  assert.equal(looksLikeAgentId('a1b2c3d4'), true);
  assert.equal(looksLikeAgentId('a1b2-c3d4-e5f6'), true);
  assert.equal(looksLikeAgentId('find the billing agent'), false); // spaces
  assert.equal(looksLikeAgentId('g1z2'), false); // non-hex chars
  assert.equal(looksLikeAgentId('a'.repeat(33)), false); // too long
});

test('call() sends namespace/params and merges cap into context.metadata', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return { ok: true };
  });

  const result = await client.call('some.namespace', { x: 1 });

  assert.deepEqual(result, { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].namespace, 'some.namespace');
  assert.deepEqual(requests[0].params, { x: 1 });
  assert.equal((requests[0].context as any).metadata._cap, 'cap-token');
  assert.equal((requests[0].context as any).metadata.trace, 'abc');
});

test('a2a() calls agent.delegate directly when target already looks like an agent id', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return { delegated: true };
  });

  await client.a2a('a1b2c3d4', { foo: 1 }, 'test purpose');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].namespace, 'agent.delegate');
  assert.deepEqual(requests[0].params, {
    agentId: 'a1b2c3d4',
    data: { foo: 1 },
    purpose: 'test purpose',
  });
});

test('a2a() resolves a natural-language target via workspace.searchAgents first', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    if (req.namespace === 'workspace.searchAgents') {
      return [{ id: 'resolved-agent-id' }];
    }
    return { delegated: true };
  });

  await client.a2a('the billing support agent', { foo: 1 }, 'test purpose');

  assert.equal(requests.length, 2);
  assert.equal(requests[0].namespace, 'workspace.searchAgents');
  assert.equal((requests[0].params as any).query, 'the billing support agent');
  assert.equal(requests[1].namespace, 'agent.delegate');
  assert.equal((requests[1].params as any).agentId, 'resolved-agent-id');
});

test('a2a() throws when workspace.searchAgents finds no match', async () => {
  const client = makeClient(async (req) => {
    if (req.namespace === 'workspace.searchAgents') return [];
    return { delegated: true };
  });

  await assert.rejects(
    client.a2a('some nonexistent agent', {}, 'purpose'),
    /No agent found matching/,
  );
});

test('ask()/hil() forward to the expected namespaces with the expected params', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return req.namespace === 'agent.ask' ? 'the answer' : { value: 'x', is_custom: false };
  });

  const answer = await client.ask('what is 2+2?', { type: 'number' });
  assert.equal(answer, 'the answer');
  assert.equal(requests[0].namespace, 'agent.ask');
  assert.deepEqual(requests[0].params, { question: 'what is 2+2?', schema: { type: 'number' } });

  const hilResult = await client.hil('confirm-key', 'Proceed?', { allow_custom_input: true });
  assert.deepEqual(hilResult, { value: 'x', is_custom: false });
  assert.equal(requests[1].namespace, 'agent.hil');
  assert.deepEqual(requests[1].params, {
    key: 'confirm-key',
    prompt: 'Proceed?',
    allow_custom_input: true,
  });
});

test('config getter falls back to an empty object when context.config is missing', () => {
  const client = makeClient(async () => ({}), { config: undefined });
  assert.deepEqual(client.config, {});
});

test('stream.* throws a clear, actionable error for Docker-runtime plugins', () => {
  const client = makeClient(async () => ({}));
  assert.throws(() => client.stream.message(), /realtime\.publish/);
  assert.throws(() => client.stream.comment('task-1'), /realtime\.publish/);
  assert.throws(() => client.stream.task('task-1'), /realtime\.publish/);
});

test('ai.promptStream() calls the ai.promptStream namespace with quest/opts and merges cap into context', () => {
  const requests: InvokeRequest[] = [];
  const client = makeStreamingClient((req) => {
    requests.push(req);
    return fakeStreamHandle(['Hel', 'lo', ' world']);
  });

  const result = client.ai.promptStream('say hello', { temperature: 0.2 });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].namespace, 'ai.promptStream');
  assert.deepEqual(requests[0].params, { quest: 'say hello', opts: { temperature: 0.2 } });
  assert.equal((requests[0].context as any).metadata._cap, 'cap-token');
  assert.ok(result.textStream);
  assert.ok(result.text instanceof Promise);
});

test('ai.promptStream() textStream yields deltas in order and text resolves to the aggregated result', async () => {
  const client = makeStreamingClient(() => fakeStreamHandle(['Hel', 'lo', ' world']));
  const result = client.ai.promptStream('say hello');

  const collected: string[] = [];
  for await (const delta of result.textStream) collected.push(delta);

  assert.deepEqual(collected, ['Hel', 'lo', ' world']);
  assert.equal(await result.text, 'Hello world');
});

test('ai.promptStream() text resolves even when textStream is never iterated', async () => {
  const client = makeStreamingClient(() => fakeStreamHandle(['ignored', ' chunks']));
  const result = client.ai.promptStream('say hello');
  assert.equal(await result.text, 'ignored chunks');
});
