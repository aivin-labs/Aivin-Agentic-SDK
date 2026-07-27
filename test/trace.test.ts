import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTrace, getCurrentTrace, formatTraceForConsole } from '../src/sdk/trace';
import { emitTraceForTest } from '../src/grpc/GrpcInvoker';

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
      emitTraceForTest({ namespace: 'datastore.getRow', durationMs: 7, attempts: 2, success: false, error: 'boom' });
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
      { namespace: 'datastore.getRow', durationMs: 20, attempts: 2, success: false, error: 'timeout', seq: 2, ts: 1120 },
    ],
  });

  assert.match(rendered, /render-me/);
  assert.match(rendered, /2 call\(s\), 123ms total/);
  assert.match(rendered, /ai\.prompt/);
  assert.match(rendered, /\(2 attempts\)/);
  assert.match(rendered, /timeout/);
  assert.match(rendered, /Result: success/);
  assert.equal(rendered.includes(String.fromCharCode(27) + '['), false); // no raw ANSI escapes - see trace.ts's comment on why
});

test('formatTraceForConsole notes when no sdk.* calls were made', () => {
  const rendered = formatTraceForConsole({
    mission: 'empty-mission',
    startedAt: 1000,
    finishedAt: 1005,
    success: true,
    events: [],
  });
  assert.match(rendered, /no sdk\.\* calls were made/);
});
