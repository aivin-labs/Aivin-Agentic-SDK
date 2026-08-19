import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import { loadSdkTransportService } from '../src/grpc/loadProto';
import { invokeHostStream, configureTransport } from '../src/grpc/GrpcInvoker';

/**
 * Everything in sdkClient.test.ts injects a fake `invokeStream` that already returns a
 * pre-built StreamHandle - it verifies SDKClient's wiring, not that GrpcInvoker.invokeHostStream
 * itself correctly demultiplexes real SdkStreamChunk messages (delta / event_type+event_json /
 * done) coming off an actual gRPC connection into chunks/lines/rawLines/reasoning/final. These
 * tests stand up a real, local, insecure gRPC server implementing SdkTransportService and drive
 * invokeHostStream() against it, to close that gap for the new line-streaming feature.
 */

type StreamCall = grpc.ServerWritableStream<any, any>;

function startServer(handler: (call: StreamCall) => void): Promise<{ endpoint: string; close: () => void }> {
  const ServiceCtor = loadSdkTransportService();
  const server = new grpc.Server();
  server.addService(ServiceCtor.service, {
    Invoke: (_call: any, callback: any) => callback(null, { success: true, data_json: '{}', error: '' }),
    InvokeStream: handler,
  });
  return new Promise((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) return reject(err);
      resolve({
        endpoint: `127.0.0.1:${port}`,
        close: () => server.forceShutdown(),
      });
    });
  });
}

async function drain<T>(gen: AsyncGenerator<T, void, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

test('invokeHostStream() demultiplexes delta/parsed_line/line/reasoning chunks from a real gRPC stream', async () => {
  const { endpoint, close } = await startServer((call) => {
    call.write({ delta: 'Hel', done: false, data_json: '', success: true, error: '', event_type: '', event_json: '' });
    call.write({ delta: 'lo', done: false, data_json: '', success: true, error: '', event_type: '', event_json: '' });
    call.write({
      delta: '', done: false, data_json: '', success: true, error: '',
      event_type: 'parsed_line',
      event_json: JSON.stringify({ parsed: { form: 'NODE', fields: { id: 'a' } }, index: 0 }),
    });
    // A line that didn't match lineSchema - server sends parsed: null, client must skip it in `lines`.
    call.write({
      delta: '', done: false, data_json: '', success: true, error: '',
      event_type: 'parsed_line',
      event_json: JSON.stringify({ parsed: null, index: 1 }),
    });
    call.write({
      delta: '', done: false, data_json: '', success: true, error: '',
      event_type: 'line', event_json: JSON.stringify({ line: 'NODE [id:a]' }),
    });
    call.write({
      delta: '', done: false, data_json: '', success: true, error: '',
      event_type: 'reasoning', event_json: JSON.stringify({ text: 'thinking...' }),
    });
    call.write({ delta: '', done: true, data_json: JSON.stringify('Hello'), success: true, error: '', event_type: '', event_json: '' });
    call.end();
  });

  try {
    configureTransport({ endpoint });
    const handle = invokeHostStream<string>({ namespace: 'ai.promptStream', params: { quest: 'hi' } });

    const [chunks, lines, rawLines, reasoning, final] = await Promise.all([
      drain(handle.chunks),
      drain(handle.lines),
      drain(handle.rawLines),
      drain(handle.reasoning),
      handle.final,
    ]);

    assert.deepEqual(chunks, ['Hel', 'lo']);
    assert.deepEqual(lines, [{ form: 'NODE', fields: { id: 'a' } }]);
    assert.deepEqual(rawLines, ['NODE [id:a]']);
    assert.deepEqual(reasoning, ['thinking...']);
    assert.equal(final, 'Hello');
  } finally {
    close();
  }
});

test('invokeHostStream() drops a chunk with malformed event_json instead of failing the stream', async () => {
  const { endpoint, close } = await startServer((call) => {
    call.write({
      delta: '', done: false, data_json: '', success: true, error: '',
      event_type: 'parsed_line', event_json: '{not valid json',
    });
    call.write({ delta: 'ok', done: false, data_json: '', success: true, error: '', event_type: '', event_json: '' });
    call.write({ delta: '', done: true, data_json: JSON.stringify('ok'), success: true, error: '', event_type: '', event_json: '' });
    call.end();
  });

  try {
    configureTransport({ endpoint });
    const handle = invokeHostStream<string>({ namespace: 'ai.promptStream', params: { quest: 'hi' } });

    const [chunks, lines, final] = await Promise.all([drain(handle.chunks), drain(handle.lines), handle.final]);

    assert.deepEqual(chunks, ['ok']);
    assert.deepEqual(lines, []);
    assert.equal(final, 'ok');
  } finally {
    close();
  }
});

test('invokeHostStream() rejects chunks/lines/final when the server reports failure mid-stream', async () => {
  const { endpoint, close } = await startServer((call) => {
    call.write({ delta: 'partial', done: false, data_json: '', success: true, error: '', event_type: '', event_json: '' });
    call.write({ delta: '', done: true, data_json: '', success: false, error: 'boom', event_type: '', event_json: '' });
    call.end();
  });

  try {
    configureTransport({ endpoint });
    const handle = invokeHostStream<string>({ namespace: 'ai.promptStream', params: { quest: 'hi' } });

    await assert.rejects(handle.final, /boom/);
    await assert.rejects(drain(handle.chunks), /boom/);
    await assert.rejects(drain(handle.lines), /boom/);
  } finally {
    close();
  }
});

test('invokeHostStream() aborts the underlying call via signal and rejects final', async () => {
  let serverSawCancel = false;
  const { endpoint, close } = await startServer((call) => {
    call.on('cancelled', () => { serverSawCancel = true; });
    call.write({ delta: 'first', done: false, data_json: '', success: true, error: '', event_type: '', event_json: '' });
    // Deliberately never end() - the client aborts before any 'done' chunk arrives.
  });

  try {
    configureTransport({ endpoint });
    const controller = new AbortController();
    const handle = invokeHostStream<string>({ namespace: 'ai.promptStream', params: { quest: 'hi' }, signal: controller.signal });

    // Let the first chunk arrive, then abort.
    const first = await handle.chunks.next();
    assert.equal(first.done, false);
    controller.abort();

    await assert.rejects(handle.final);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(serverSawCancel, true);
  } finally {
    close();
  }
});
