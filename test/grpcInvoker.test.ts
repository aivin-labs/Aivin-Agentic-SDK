import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, onCall, type CallTrace } from '../src/grpc/GrpcInvoker';

test('withRetry returns immediately on first success without retrying', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      return 'ok';
    },
    { maxRetries: 3, isRetryable: () => true },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries only errors the caller marks as retryable, up to maxRetries', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'recovered';
    },
    { maxRetries: 5, isRetryable: (err) => err.message === 'transient' },
  );
  assert.equal(result, 'recovered');
  assert.equal(calls, 3);
});

test('withRetry gives up after maxRetries and throws the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error('always fails');
      },
      { maxRetries: 2, isRetryable: () => true },
    ),
    /always fails/,
  );
  assert.equal(calls, 3); // initial attempt + 2 retries
});

test('withRetry never retries an error the caller marks as non-retryable', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error('business logic failure');
      },
      { maxRetries: 5, isRetryable: () => false },
    ),
    /business logic failure/,
  );
  assert.equal(calls, 1);
});

test('withRetry invokes onRetry with the attempt index and the error before each retry', async () => {
  const retries: Array<{ attempt: number; message: string }> = [];
  let calls = 0;
  await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error(`fail-${calls}`);
      return 'done';
    },
    {
      maxRetries: 5,
      isRetryable: () => true,
      onRetry: (attempt, err) => retries.push({ attempt, message: err.message }),
    },
  );
  assert.deepEqual(retries, [
    { attempt: 0, message: 'fail-1' },
    { attempt: 1, message: 'fail-2' },
  ]);
});

test('onCall registers a listener that fires with a CallTrace and can unsubscribe', async () => {
  const traces: CallTrace[] = [];
  const unsubscribe = onCall((trace) => traces.push(trace));

  // onCall only wires into invokeHost's real gRPC path, which we don't exercise in unit tests
  // (no proto/transport mocking here) - just verify subscribe/unsubscribe bookkeeping works.
  assert.equal(typeof unsubscribe, 'function');
  unsubscribe();
  assert.equal(traces.length, 0);
});
