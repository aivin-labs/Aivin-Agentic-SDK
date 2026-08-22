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

/** Fake StreamHandle backing a promptStream()/prompt(listener) test - yields `deltas` (plus
 *  optional `lines`/`rawLines`/`reasoning`) then resolves `final` to their concatenation, without
 *  touching the real gRPC transport. */
function fakeStreamHandle(
  deltas: string[],
  extra: { lines?: import('../src/types/SDKTypes').ParsedLine[]; rawLines?: string[]; reasoning?: string[]; final?: Promise<string> } = {},
): StreamHandle<string> {
  async function* toGen<V>(items: V[]): AsyncGenerator<V, void, void> {
    for (const item of items) yield item;
  }
  return {
    chunks: toGen(deltas),
    final: extra.final ?? Promise.resolve(deltas.join('')),
    lines: toGen(extra.lines ?? []),
    rawLines: toGen(extra.rawLines ?? []),
    reasoning: toGen(extra.reasoning ?? []),
  };
}

function makeStreamingClient(
  invokeStream: (request: InvokeRequest) => StreamHandle<any>,
  invoke: (request: InvokeRequest) => Promise<any> = async () => ({}),
) {
  const identity: PluginIdentity = {
    user: { id: 'u1' } as any,
    workspace: { id: 'w1' } as any,
    session: {} as any,
    org_id: 'org1',
    client: 'test',
    config: {},
    metadata: {},
  } as PluginIdentity;
  return new SDKClient(identity, { cap: 'cap-token', invoke, invokeStream });
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

// ── Regression tests for the task.* field-name drift fixed 2026-08-21 ──────────────────────────
// `content`/`assignee_id`/`due_date` looked plausible and matched this SDK's own (also-wrong)
// Task type, but the real backend (TaskService._sanitizeCreateTaskInput/UpdateTaskDTO/
// TaskFilterRequest) only ever accepted `description`/`assign_id`/`from_date`+`to_date` - every
// other field here was silently dropped server-side. Pinning the exact wire shape so this can't
// silently drift back.
test('task.create() sends description/assign_id/from_date/to_date - not content/assignee_id/due_date', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return { id: 't1' };
  });

  await client.task.create({ title: 'Fix login bug', description: 'Users cannot log in on Safari', assign_id: 'u2', workspace_id: 'w1', to_date: '2026-09-01' });

  assert.equal(requests[0].namespace, 'task.createTask');
  assert.deepEqual(requests[0].params, {
    title: 'Fix login bug',
    description: 'Users cannot log in on Safari',
    assign_id: 'u2',
    workspace_id: 'w1',
    to_date: '2026-09-01',
  });
  assert.ok(!('content' in (requests[0].params as any)));
  assert.ok(!('assignee_id' in (requests[0].params as any)));
  assert.ok(!('due_date' in (requests[0].params as any)));
});

test('task.update() sends description, not content, alongside task_id', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return { id: 't1' };
  });

  await client.task.update('t1', { status: 'doing', description: 'Updated details' });

  assert.equal(requests[0].namespace, 'task.updateTask');
  assert.deepEqual(requests[0].params, { task_id: 't1', status: 'doing', description: 'Updated details' });
});

test('task.list() filters by assign_id, not assignee_id', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return [];
  });

  await client.task.list({ workspace_id: 'w1', assign_id: 'u2' });

  assert.equal(requests[0].namespace, 'task.getTasks');
  assert.deepEqual(requests[0].params, { workspace_id: 'w1', assign_id: 'u2' });
});

test('triggerPlugin() dispatches through the plugin.trigger namespace with pluginId/mission as separate fields, not concatenated', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return { status: 'success', data: { ok: true } };
  });

  const result = await client.triggerPlugin('official.comprehensive_audit', 'Audit Q3 report', { content: 'x' });

  assert.deepEqual(result, { status: 'success', data: { ok: true } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].namespace, 'plugin.trigger');
  // plugin_id must stay intact (including its own dots) - never split like call('id.purpose', ...) would.
  assert.deepEqual(requests[0].params, {
    plugin_id: 'official.comprehensive_audit',
    mission: 'Audit Q3 report',
    arguments: { content: 'x' },
    workspace_id: undefined,
    agent_id: undefined,
    session_id: undefined,
  });
});

test('triggerPlugin() forwards opts.workspaceId/agentId/sessionId/timeoutMs as target-override fields', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return {};
  });

  await client.triggerPlugin('official.task_report', 'Weekly report', { period: 'weekly' }, {
    workspaceId: 'ws_marketing',
    agentId: 'agent_reporting_bot',
    sessionId: 'sess_1',
    timeoutMs: 5000,
  });

  assert.equal(requests[0].params.workspace_id, 'ws_marketing');
  assert.equal(requests[0].params.agent_id, 'agent_reporting_bot');
  assert.equal(requests[0].params.session_id, 'sess_1');
  assert.equal(requests[0].timeoutMs, 5000);
});

test('pluginInfo() calls plugin.info with plugin_id', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return { id: 'official.comprehensive_audit', name: 'Audit' };
  });

  const result = await client.pluginInfo('official.comprehensive_audit');

  assert.deepEqual(result, { id: 'official.comprehensive_audit', name: 'Audit' });
  assert.equal(requests[0].namespace, 'plugin.info');
  assert.deepEqual(requests[0].params, { plugin_id: 'official.comprehensive_audit' });
});

test('pluginSearch() calls plugin.search with query/limit/threshold', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return [{ id: 'official.a' }, { id: 'official.b' }];
  });

  const result = await client.pluginSearch('audit a report', { limit: 5, threshold: 0.5 });

  assert.equal(result.length, 2);
  assert.equal(requests[0].namespace, 'plugin.search');
  assert.deepEqual(requests[0].params, { query: 'audit a report', limit: 5, threshold: 0.5 });
});

test('pluginFit() calls plugin.fit with query/allowed_plugin_ids and can resolve null', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return null;
  });

  const result = await client.pluginFit('audit a report', { allowedPluginIds: ['official.a', 'official.b'] });

  assert.equal(result, null);
  assert.equal(requests[0].namespace, 'plugin.fit');
  assert.deepEqual(requests[0].params, { query: 'audit a report', allowed_plugin_ids: ['official.a', 'official.b'] });
});

test('pluginInfoBatch() calls plugin.infoBatch with plugin_ids', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return [{ id: 'official.a' }, { id: 'official.b' }];
  });

  const result = await client.pluginInfoBatch(['official.a', 'official.b']);

  assert.equal(result.length, 2);
  assert.equal(requests[0].namespace, 'plugin.infoBatch');
  assert.deepEqual(requests[0].params, { plugin_ids: ['official.a', 'official.b'] });
});

test('pluginStatus() calls plugin.status with plugin_id and returns allowed/state', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return { allowed: false, state: 'open' };
  });

  const result = await client.pluginStatus('official.comprehensive_audit');

  assert.deepEqual(result, { allowed: false, state: 'open' });
  assert.equal(requests[0].namespace, 'plugin.status');
  assert.deepEqual(requests[0].params, { plugin_id: 'official.comprehensive_audit' });
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

test('ai.prompt() with no listener uses the plain unary call, never touches invokeStream', async () => {
  const invokeCalls: InvokeRequest[] = [];
  const client = makeStreamingClient(
    () => { throw new Error('should not open a stream'); },
    async (req) => { invokeCalls.push(req); return 'a plain reply'; },
  );

  const result = await client.ai.prompt('say hello', { temperature: 0.2 });

  assert.equal(result, 'a plain reply');
  assert.equal(invokeCalls.length, 1);
  assert.equal(invokeCalls[0].namespace, 'ai.prompt');
});

test('ai.prompt() unary path forwards opts.signal to invoke() and strips it out of the wire opts', async () => {
  const invokeCalls: InvokeRequest[] = [];
  const client = makeStreamingClient(
    () => { throw new Error('should not open a stream'); },
    async (req) => { invokeCalls.push(req); return 'a plain reply'; },
  );
  const controller = new AbortController();

  await client.ai.prompt('q', { temperature: 0.2, signal: controller.signal });

  assert.equal(invokeCalls.length, 1);
  assert.equal(invokeCalls[0].signal, controller.signal);
  assert.deepEqual(invokeCalls[0].params, { quest: 'q', opts: { temperature: 0.2 } }, 'signal must not leak into the wire opts');
});

test('ai.prompt() streaming path forwards opts.signal to invokeStream() and strips it out of the wire opts', () => {
  const requests: InvokeRequest[] = [];
  const client = makeStreamingClient((req) => { requests.push(req); return fakeStreamHandle([]); });
  const controller = new AbortController();

  client.ai.prompt('q', { temperature: 0.2, signal: controller.signal }, { onUpdate: () => {} });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal, controller.signal);
  assert.deepEqual(requests[0].params, {
    quest: 'q',
    opts: { temperature: 0.2 },
    wantsRawLine: false,
    wantsReasoning: false,
  });
});

test('ai.prompt() with a MessageListener (even one with only onCompleted) streams, not the unary call', async () => {
  const invokeCalls: InvokeRequest[] = [];
  const streamCalls: InvokeRequest[] = [];
  const client = makeStreamingClient(
    (req) => { streamCalls.push(req); return fakeStreamHandle(['a', ' streamed', ' reply']); },
    async (req) => { invokeCalls.push(req); return 'should not be used'; },
  );

  let completed: any;
  const result = await client.ai.prompt('say hello', undefined, { onCompleted: () => { completed = true; } });

  assert.equal(result, 'a streamed reply');
  assert.equal(streamCalls.length, 1, 'any 3rd arg (Writable or MessageListener) must trigger the streaming RPC');
  assert.equal(invokeCalls.length, 0);
  assert.equal(completed, true);
});

test('ai.prompt() with a Writable-shaped 3rd arg (.write/.end) pipes text deltas into it and calls .end()', async () => {
  const client = makeStreamingClient(() => fakeStreamHandle(['Hel', 'lo', ' world']));
  const written: string[] = [];
  let ended = false;
  const fakeWritable = {
    write: (chunk: string) => { written.push(chunk); return true; },
    end: () => { ended = true; },
  };

  const result = await client.ai.prompt('say hello', undefined, fakeWritable as any);

  assert.deepEqual(written, ['Hel', 'lo', ' world']);
  assert.equal(ended, true);
  assert.equal(result, 'Hello world');
});

test('ai.prompt() Writable adapter respects real backpressure - waits for "drain" before writing the next chunk', async () => {
  const client = makeStreamingClient(() => fakeStreamHandle(['a', 'b', 'c']));
  const written: string[] = [];
  const drainListeners: Array<() => void> = [];
  let writeCallCount = 0;
  const fakeWritable = {
    write: (chunk: string) => {
      written.push(chunk);
      writeCallCount++;
      return writeCallCount !== 1; // simulate the buffer being full after the 1st write only
    },
    end: () => {},
    once: (event: string, cb: () => void) => { if (event === 'drain') drainListeners.push(cb); },
  };

  const promise = client.ai.prompt('q', undefined, fakeWritable as any);

  // Let the drain loop run far enough to write chunk 1 and get stuck awaiting 'drain'.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(written, ['a'], 'must not write the 2nd chunk until "drain" fires for the 1st');
  assert.equal(drainListeners.length, 1);

  drainListeners[0](); // simulate the writable actually draining
  await promise;

  assert.deepEqual(written, ['a', 'b', 'c']);
});

test('ai.prompt() with a Writable-shaped 3rd arg calls .destroy(err) instead of .end() when the stream fails', async () => {
  const client = makeStreamingClient(() => fakeStreamHandle(['partial'], { final: Promise.reject(new Error('boom')) }));
  let destroyErr: any;
  let ended = false;
  const fakeWritable = {
    write: () => true,
    end: () => { ended = true; },
    destroy: (err: any) => { destroyErr = err; },
  };

  await assert.rejects(client.ai.prompt('say hello', undefined, fakeWritable as any), /boom/);

  assert.equal(ended, false);
  assert.equal(destroyErr?.message, 'boom');
});

test('ai.prompt() with onUpdate streams chunks in order and resolves to the aggregated result', async () => {
  const client = makeStreamingClient(() => fakeStreamHandle(['Hel', 'lo', ' world']));
  const collected: string[] = [];
  let completed = false;

  const result = await client.ai.prompt('say hello', undefined, {
    onUpdate: (delta) => collected.push(delta),
    onCompleted: () => { completed = true; },
  });

  assert.deepEqual(collected, ['Hel', 'lo', ' world']);
  assert.equal(result, 'Hello world');
  assert.equal(completed, true);
});

test('ai.prompt() sets wantsRawLine/wantsReasoning in params based on which callbacks the listener declares', () => {
  const requests: InvokeRequest[] = [];
  const client = makeStreamingClient((req) => {
    requests.push(req);
    return fakeStreamHandle([]);
  });

  client.ai.prompt('q', undefined, { onUpdate: () => {} });
  client.ai.prompt('q', undefined, { onUpdate: () => {}, onLine: () => {} });
  client.ai.prompt('q', undefined, { onUpdate: () => {}, onReasoning: () => {} });

  assert.deepEqual(requests[0].params, { quest: 'q', opts: {}, wantsRawLine: false, wantsReasoning: false });
  assert.deepEqual(requests[1].params, { quest: 'q', opts: {}, wantsRawLine: true, wantsReasoning: false });
  assert.deepEqual(requests[2].params, { quest: 'q', opts: {}, wantsRawLine: false, wantsReasoning: true });
});

test('ai.prompt() onParsedLine/onLine/onReasoning receive events from their respective streams', async () => {
  const client = makeStreamingClient(() =>
    fakeStreamHandle(['ignored text'], {
      lines: [{ form: 'NODE', fields: { id: 'a' } }],
      rawLines: ['raw line 1'],
      reasoning: ['thinking...'],
    }),
  );

  const parsedLines: any[] = [];
  const rawLines: string[] = [];
  const reasoningChunks: string[] = [];

  await client.ai.prompt('q', { lineSchema: 'NODE [id:string - id]' }, {
    onParsedLine: (parsed, index) => parsedLines.push({ parsed, index }),
    onLine: (line) => rawLines.push(line),
    onReasoning: (text) => reasoningChunks.push(text),
  });

  assert.deepEqual(parsedLines, [{ parsed: { form: 'NODE', fields: { id: 'a' } }, index: 0 }]);
  assert.deepEqual(rawLines, ['raw line 1']);
  assert.deepEqual(reasoningChunks, ['thinking...']);
});

test('ai.prompt() calls onError (not onCompleted) when the stream fails, and rejects for the caller', async () => {
  const client = makeStreamingClient(() =>
    fakeStreamHandle(['partial'], { final: Promise.reject(new Error('transport blew up')) }),
  );

  let completedFired = false;
  let errorSeen: any;

  await assert.rejects(
    client.ai.prompt('q', undefined, {
      onUpdate: () => {},
      onCompleted: () => { completedFired = true; },
      onError: (err) => { errorSeen = err; },
    }),
    /transport blew up/,
  );

  assert.equal(completedFired, false);
  assert.equal(errorSeen?.message, 'transport blew up');
});

test('ai.prompt() a throwing onUpdate is caught and logged, not left to silently drop the rest of the stream', async () => {
  const originalConsoleError = console.error;
  const loggedErrors: any[] = [];
  console.error = (...args: any[]) => { loggedErrors.push(args); };
  try {
    const client = makeStreamingClient(() => fakeStreamHandle(['a', 'b', 'c']));
    const seen: string[] = [];

    const result = await client.ai.prompt('q', undefined, {
      onUpdate: (delta) => {
        seen.push(delta);
        if (delta === 'b') throw new Error('boom from a buggy plugin callback');
      },
    });

    // 'a' and 'c' still got through despite 'b' throwing - the bug didn't truncate the stream.
    assert.deepEqual(seen, ['a', 'b', 'c']);
    assert.equal(result, 'abc');
    assert.ok(loggedErrors.some((args) => String(args[1]?.message ?? args[1]).includes('boom from a buggy plugin callback')));
  } finally {
    console.error = originalConsoleError;
  }
});

test('ai.cancel() calls the ai.cancel namespace with unique_request_id', async () => {
  const requests: InvokeRequest[] = [];
  const client = makeClient(async (req) => {
    requests.push(req);
    return { cancelled_locally: true };
  });

  const result = await client.ai.cancel('req-123');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].namespace, 'ai.cancel');
  assert.deepEqual(requests[0].params, { unique_request_id: 'req-123' });
  assert.deepEqual(result, { cancelled_locally: true });
});

test('ai.prompt() translates opts.request_id to the wire field unique_request_id (unlike opts.signal, it is NOT stripped)', async () => {
  const invokeCalls: InvokeRequest[] = [];
  const client = makeStreamingClient(
    () => { throw new Error('should not open a stream'); },
    async (req) => { invokeCalls.push(req); return 'a plain reply'; },
  );

  await client.ai.prompt('q', { request_id: 'req-456' });

  assert.deepEqual(invokeCalls[0].params, { quest: 'q', opts: { unique_request_id: 'req-456' } });
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
