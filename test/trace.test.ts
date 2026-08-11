import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTrace, getCurrentTrace, formatTraceForConsole } from '../src/sdk/trace';
import { emitTraceForTest, configureTransport } from '../src/grpc/GrpcInvoker';

test('withTrace returns the handler result on success and reports a finished, successful trace', async () => {
  let reported: any;
  const result = await withTrace(
    'test-mission',
    async () => 'handler result',
    (trace) => (reported = trace),
  );

  assert.equal(result, 'handler result');
  assert.equal(reported.mission, 'test-mission');
  assert.equal(reported.success, true);
  assert.equal(reported.error, undefined);
  assert.ok(reported.finishedAt >= reported.startedAt);
  assert.deepEqual(reported.events, []);
  assert.deepEqual(reported.logs, []);
});

test('withTrace rethrows on failure and still reports a finished, failed trace', async () => {
  let reported: any;
  await assert.rejects(
    withTrace(
      'failing-mission',
      async () => {
        throw new Error('handler blew up');
      },
      (trace) => (reported = trace),
    ),
    /handler blew up/,
  );

  assert.equal(reported.mission, 'failing-mission');
  assert.equal(reported.success, false);
  assert.equal(reported.error, 'handler blew up');
});

test('getCurrentTrace() reflects the active invocation while it runs, and is undefined outside one', async () => {
  assert.equal(getCurrentTrace(), undefined);

  await withTrace('inspect-me', async () => {
    const active = getCurrentTrace();
    assert.equal(active?.mission, 'inspect-me');
  });

  assert.equal(getCurrentTrace(), undefined);
});

test('withTrace isolates concurrent invocations from each other (no cross-talk)', async () => {
  const results = await Promise.all([
    withTrace('mission-a', async () => {
      await new Promise((r) => setTimeout(r, 10));
      return getCurrentTrace()?.mission;
    }),
    withTrace('mission-b', async () => {
      return getCurrentTrace()?.mission;
    }),
  ]);

  assert.deepEqual(results, ['mission-a', 'mission-b']);
});

test('sdk.* calls made during the handler are recorded on the active trace via onCall', async () => {
  let reported: any;
  await withTrace(
    'traced-calls',
    async () => {
      // Simulates the same onCall() firing invokeHost() does internally on every real call, without
      // needing an actual gRPC round trip.
      emitTraceForTest({ namespace: 'ai.prompt', durationMs: 42, attempts: 1, success: true });
      emitTraceForTest({ namespace: 'table.getRow', durationMs: 7, attempts: 2, success: false, error: 'boom' });
    },
    (trace) => (reported = trace),
  );

  assert.equal(reported.events.length, 2);
  assert.equal(reported.events[0].namespace, 'ai.prompt');
  assert.equal(reported.events[0].seq < reported.events[1].seq, true);
  assert.equal(reported.events[1].success, false);
  assert.equal(reported.events[1].error, 'boom');
});

test('formatTraceForConsole renders a readable timeline with status icons and no ANSI color codes', () => {
  const rendered = formatTraceForConsole({
    mission: 'render-me',
    startedAt: 1000,
    finishedAt: 1123,
    success: true,
    events: [
      { namespace: 'ai.prompt', durationMs: 100, attempts: 1, success: true, seq: 1, ts: 1100 },
      { namespace: 'table.getRow', durationMs: 20, attempts: 2, success: false, error: 'timeout', seq: 2, ts: 1120 },
    ],
    logs: [],
  });

  assert.match(rendered, /render-me/);
  assert.match(rendered, /2 call\(s\), 0 log line\(s\), 123ms total/);
  assert.match(rendered, /ai\.prompt/);
  assert.match(rendered, /\(2 attempts\)/);
  assert.match(rendered, /timeout/);
  assert.match(rendered, /Result: success/);
  assert.equal(rendered.includes(String.fromCharCode(27) + '['), false); // no raw ANSI escapes - see trace.ts's comment on why
});

test('formatTraceForConsole notes when no sdk.* calls or console output were made', () => {
  const rendered = formatTraceForConsole({
    mission: 'empty-mission',
    startedAt: 1000,
    finishedAt: 1005,
    success: true,
    events: [],
    logs: [],
  });
  assert.match(rendered, /no sdk\.\* calls or console output/);
});

test('formatTraceForConsole interleaves calls and console output by seq, in true chronological order', () => {
  const rendered = formatTraceForConsole({
    mission: 'mixed-timeline',
    startedAt: 1000,
    finishedAt: 1100,
    success: true,
    events: [{ namespace: 'ai.prompt', durationMs: 50, attempts: 1, success: true, seq: 2, ts: 1050 }],
    logs: [
      { level: 'log', message: 'before the call', ts: 1010, seq: 1 },
      { level: 'error', message: 'after the call', ts: 1090, seq: 3 },
    ],
  });

  const beforeIdx = rendered.indexOf('before the call');
  const callIdx = rendered.indexOf('ai.prompt');
  const afterIdx = rendered.indexOf('after the call');
  assert.ok(beforeIdx > 0 && beforeIdx < callIdx, 'log seq=1 should render before the call seq=2');
  assert.ok(callIdx < afterIdx, 'call seq=2 should render before log seq=3');
});

test('plain console.log/warn/error calls made during a traced invocation are captured onto the trace', async () => {
  let reported: any;
  await withTrace(
    'console-capture',
    async () => {
      console.log('hello from plugin code');
      console.error('something went wrong: %s', 'oops');
    },
    (trace) => (reported = trace),
  );

  assert.equal(reported.logs.length, 2);
  assert.equal(reported.logs[0].level, 'log');
  assert.equal(reported.logs[0].message, 'hello from plugin code');
  assert.equal(reported.logs[1].level, 'error');
  assert.equal(reported.logs[1].message, 'something went wrong: oops'); // util.format %s substitution
  assert.ok(reported.logs[0].seq < reported.logs[1].seq);
});

test('console capture isolates concurrent invocations from each other (no cross-talk)', async () => {
  const results: any[] = [];
  await Promise.all([
    withTrace(
      'mission-a',
      async () => {
        console.log('log from A');
        await new Promise((r) => setTimeout(r, 10));
      },
      (trace) => (results[0] = trace),
    ),
    withTrace(
      'mission-b',
      async () => {
        console.log('log from B');
      },
      (trace) => (results[1] = trace),
    ),
  ]);

  assert.deepEqual(
    results[0].logs.map((l: any) => l.message),
    ['log from A'],
  );
  assert.deepEqual(
    results[1].logs.map((l: any) => l.message),
    ['log from B'],
  );
});

test('console output made outside any withTrace() is not captured anywhere', () => {
  assert.equal(getCurrentTrace(), undefined);
  console.log('untraced line');
  // Nothing to assert against directly (there's no trace to inspect) - this just documents/locks
  // in that calling console.log() outside an invocation is a no-op for capture, matching how
  // sdk.* calls made outside main() are already dropped by the onCall() subscription above.
});

test('a console line containing the resolved SDK secret gets it redacted before landing on the trace', async () => {
  configureTransport({ secret: 'super-secret-token' });
  try {
    let reported: any;
    await withTrace(
      'leaky-mission',
      async () => {
        console.log('using token super-secret-token to authenticate');
      },
      (trace) => (reported = trace),
    );

    assert.equal(reported.logs[0].message, 'using token [REDACTED] to authenticate');
    assert.equal(reported.logs[0].message.includes('super-secret-token'), false);
  } finally {
    configureTransport({ secret: undefined }); // don't leak this fake secret into other test files
  }
});

test('generic credential-shaped patterns (not just the SDK secret) are redacted from captured console output', async () => {
  let reported: any;
  await withTrace(
    'third-party-creds-mission',
    async () => {
      console.log('calling with header Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456');
      console.log('aws key AKIAABCDEFGHIJKLMNOP in use');
      console.log(
        'jwt is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      );
      console.log('db url postgres://admin:sup3rSecret@db.internal:5432/prod');
      console.log('-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----');
    },
    (trace) => (reported = trace),
  );

  const messages: string[] = reported.logs.map((l: any) => l.message);
  assert.match(messages[0], /Authorization: \[REDACTED\]/);
  assert.equal(messages[0].includes('sk-abcdefghijklmnopqrstuvwxyz123456'), false);
  assert.equal(messages[1].includes('AKIAABCDEFGHIJKLMNOP'), false);
  assert.equal(messages[2].includes('eyJhbGciOiJIUzI1NiJ9'), false);
  assert.equal(messages[3].includes('admin:sup3rSecret@'), false);
  assert.match(messages[3], /postgres:\/\/\[REDACTED\]@db\.internal/);
  assert.equal(messages[4].includes('MIIBOgIBAAJBAK'), false);
});

test('captured console output is truncated past MAX_CAPTURED_LOGS instead of growing unbounded', async () => {
  let reported: any;
  await withTrace(
    'noisy-mission',
    async () => {
      for (let i = 0; i < 250; i++) console.log('line', i);
    },
    (trace) => (reported = trace),
  );

  assert.ok(reported.logs.length <= 201, `expected capped log count, got ${reported.logs.length}`);
  assert.match(reported.logs[reported.logs.length - 1].message, /truncated/);
});
