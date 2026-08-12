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

test('browser.run() calls browser.run with mission and opts nested under data', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return { product_name: 'flagship laptop', price_usd: 999 };
  });

  const opts = {
    start_url: 'https://example-vendor.com/laptops',
    success_criteria: ['A specific price in USD has been found'],
    output_schema: { type: 'object', properties: { price_usd: { type: 'number' } } },
  };
  const result = await client.browser.run('Find the flagship laptop price', opts);

  assert.deepEqual(result, { product_name: 'flagship laptop', price_usd: 999 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].namespace, 'browser.run');
  assert.deepEqual(requests[0].params, {
    mission: 'Find the flagship laptop price',
    data: opts,
  });
  assert.equal((requests[0].context as any).metadata._cap, 'cap-token');
});

test('browser.run() works with no opts (data is undefined)', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return 'ok';
  });

  await client.browser.run('Just check the homepage loads');

  assert.equal(requests[0].namespace, 'browser.run');
  assert.deepEqual(requests[0].params, { mission: 'Just check the homepage loads', data: undefined });
});

test('browser.cancel() with no sessionId sends an empty params object', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return { success: true, session_id: 'tenant-a' };
  });

  const result = await client.browser.cancel();

  assert.deepEqual(result, { success: true, session_id: 'tenant-a' });
  assert.equal(requests[0].namespace, 'browser.cancel');
  assert.deepEqual(requests[0].params, {});
});

test('browser.cancel(sessionId) forwards session_id to target a specific mission', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return { success: true, session_id: 'tenant-b' };
  });

  await client.browser.cancel('tenant-b');

  assert.equal(requests[0].namespace, 'browser.cancel');
  assert.deepEqual(requests[0].params, { session_id: 'tenant-b' });
});

// Regression coverage for the real bug fixed alongside adding zod validation: a previous version
// of this SDK typed automation.createJob's params as { name, schedule, logic } - none of which are
// real backend field names - and nothing caught it client-side. These tests prove the *old*, wrong
// shape is now rejected locally (never reaches the network), and the *real* shape still works.
test('automation.createJob() rejects the old, wrong { name, schedule, logic } shape locally', async () => {
  let called = false;
  const client = makeClient(async () => {
    called = true;
    return {};
  });

  await assert.rejects(
    async () => {
      await (client.automation.createJob as any)({
        name: 'Weekly digest',
        schedule: '0 9 * * MON',
        logic: '{}',
      });
    },
    /automation\.createJob.*agent_id/s,
  );
  assert.equal(called, false, 'the network call must never fire when validation fails');
});

test('automation.createJob() accepts the real { mission, agent_id, ... } shape and forwards it as-is', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return { id: 'job1', mission: 'Weekly digest', status: 'pending' };
  });

  await client.automation.createJob({
    mission: 'Weekly digest',
    agent_id: 'agent1',
    schedule_condition: 'every Monday at 9am',
  });

  assert.equal(requests[0].namespace, 'automation.createJob');
  assert.deepEqual(requests[0].params, {
    mission: 'Weekly digest',
    agent_id: 'agent1',
    schedule_condition: 'every Monday at 9am',
  });
});

test('automation.getJobs() rejects a missing workspace_id locally', async () => {
  const client = makeClient(async () => []);
  await assert.rejects(
    async () => {
      await (client.automation.getJobs as any)({ limit: 20 });
    },
    /automation\.getJobs.*workspace_id/s,
  );
});

test('resource.upload() rejects a raw object that is not one of the three accepted `file` shapes', async () => {
  const client = makeClient(async () => ({}));
  await assert.rejects(
    async () => {
      await (client.resource.upload as any)({ file: { notAValidShape: true } });
    },
    /resource\.upload/,
  );
});

test('resource.upload() accepts a base64 string file and forwards params as-is', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return { id: 'r1', url: 'https://example.com/r1' };
  });

  await client.resource.upload({ file: 'aGVsbG8=', name: 'hello.txt' });

  assert.equal(requests[0].namespace, 'resource.uploadFile');
  assert.deepEqual(requests[0].params, { file: 'aGVsbG8=', name: 'hello.txt' });
});

test('store.set() forwards a valid call and rejects an empty table name locally', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return { key: 'k1' };
  });

  await client.store.set('orders', 'o1', { total: 100 });
  assert.equal(requests[0].namespace, 'store.set');
  assert.deepEqual(requests[0].params, {
    table_id: 'orders',
    key: 'o1',
    data: { total: 100 },
    ttl_seconds: undefined,
    schema: undefined,
    strict: undefined,
  });

  await assert.rejects(async () => {
    await client.store.set('', 'o1', { total: 100 });
  }, /store\.set/);
});

test('store.aggregate() rejects an invalid metrics[].op value locally', async () => {
  const client = makeClient(async () => []);
  await assert.rejects(async () => {
    await (client.store.aggregate as any)('orders', [{ op: 'median', as: 'x' }]);
  }, /store\.aggregate/);
});

test('table.addRow() forwards a valid call and rejects a missing table_id locally', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return { id: 'row1' };
  });

  await client.table.addRow({
    workspace_id: 'w1',
    project_id: 'p1',
    table_id: 't1',
    data: { name: 'Ada' },
  });
  assert.equal(requests[0].namespace, 'table.addRow');

  await assert.rejects(async () => {
    await (client.table.addRow as any)({ workspace_id: 'w1', project_id: 'p1', data: { name: 'Ada' } });
  }, /table\.addRow.*table_id/s);
});

test('table.getTables() rejects a missing project_id locally', async () => {
  const client = makeClient(async () => []);
  await assert.rejects(async () => {
    await (client.table.getTables as any)({ workspace_id: 'w1' });
  }, /table\.getTables.*project_id/s);
});

test('notification.push() remaps the documented user_id/body to the fields the backend actually reads (receiver_id/message)', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return undefined;
  });

  await client.notification.push({ user_id: 'u42', title: 'Hi', body: 'export ready' });

  assert.equal(requests[0].namespace, 'notification.pushNotification');
  assert.equal(requests[0].params.receiver_id, 'u42');
  assert.equal(requests[0].params.message, 'export ready');
  // the wrong-for-the-backend field names must not also leak through unremapped
  assert.equal((requests[0].params as any).user_id, undefined);
  assert.equal((requests[0].params as any).body, undefined);
});

test('notification.push() prefers an explicitly-passed receiver_id/message over a derived user_id/body', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return undefined;
  });

  await (client.notification.push as any)({
    user_id: 'wrong-user',
    receiver_id: 'right-user',
    body: 'wrong body',
    message: 'right message',
  });

  assert.equal(requests[0].params.receiver_id, 'right-user');
  assert.equal(requests[0].params.message, 'right message');
});

test('notification.push() accepts receiver_ids (batch) and topic (broadcast) as alternatives to user_id', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return undefined;
  });

  await (client.notification.push as any)({ receiver_ids: ['u1', 'u2'], title: 'Hi', body: 'x' });
  assert.deepEqual(requests[0].params.receiver_ids, ['u1', 'u2']);

  await (client.notification.push as any)({ topic: 'billing-alerts', title: 'Hi', body: 'x' });
  assert.equal(requests[1].params.topic, 'billing-alerts');
});

test('notification.push() rejects locally when no audience field (user_id/receiver_id/receiver_ids/topic) is given', async () => {
  let called = false;
  const client = makeClient(async () => {
    called = true;
    return undefined;
  });

  await assert.rejects(async () => {
    await (client.notification.push as any)({ title: 'Hi', body: 'x' });
  }, /notification\.push.*audience/s);
  assert.equal(called, false, 'the network call must never fire when local validation fails');
});

test('notification.push() forwards channels/priority/prompt/messageIsHtml as-is', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return undefined;
  });

  await (client.notification.push as any)({
    user_id: 'u1',
    prompt: 'tell the user their export finished',
    priority: 'urgent',
    channels: ['database', 'email'],
    messageIsHtml: true,
  });

  assert.equal(requests[0].params.prompt, 'tell the user their export finished');
  assert.equal(requests[0].params.priority, 'urgent');
  assert.deepEqual(requests[0].params.channels, ['database', 'email']);
  assert.equal(requests[0].params.messageIsHtml, true);
});
