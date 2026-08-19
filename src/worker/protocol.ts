import type { InvokeRequest } from '../grpc/GrpcInvoker';
import type { PluginIdentity } from '../sdk/SDKClient';
import type { ParsedLine, PluginInput } from '../types/SDKTypes';

/** Plain-object error shape that survives the `postMessage` structured-clone boundary in both
 *  directions, reconstructed into a real `Error` on the receiving side (see `reviveError` in
 *  `PluginWorkerRuntime`/`PluginWorkerHost`) so `catch (e) { e.message }` in plugin code never
 *  observes a difference from the non-sandboxed path. */
export interface SerializedError {
  message: string;
  stack?: string;
  code?: unknown;
}

/** Host -> Worker: kick off one invocation. Mirrors the identity/cap/explicitFunc a real
 *  `PluginServer.handleInvoke` (or `testInvoke`) already resolves before calling the handler. */
export interface InvokeMessage {
  type: 'invoke';
  requestId: string;
  mission: string;
  input: PluginInput;
  identity: Partial<PluginIdentity>;
  cap?: string;
  explicitFunc?: string;
}

/** Worker -> Host: the invocation finished (success or failure). */
export type InvokeDoneMessage =
  | { type: 'invoke.done'; requestId: string; ok: true; result: any }
  | { type: 'invoke.done'; requestId: string; ok: false; error: SerializedError };

/** Worker -> Host: the plugin's own `ctx.sdk.*`/global-import call needs the REAL transport -
 *  only the host ever has the resolved secret to actually make this call. */
export interface SdkCallMessage {
  type: 'sdk.call';
  requestId: string;
  request: InvokeRequest;
}

/** Host -> Worker: reply to a `sdk.call`. */
export type SdkCallResultMessage =
  | { type: 'sdk.call.result'; requestId: string; ok: true; data: any }
  | { type: 'sdk.call.result'; requestId: string; ok: false; error: SerializedError };

/** Worker -> Host: same as `sdk.call` but for the streaming transport (`ai.promptStream` etc). */
export interface SdkStreamStartMessage {
  type: 'sdk.stream.start';
  requestId: string;
  request: InvokeRequest;
}

/** Host -> Worker: one incremental delta of a relayed stream. */
export interface SdkStreamChunkMessage {
  type: 'sdk.stream.chunk';
  requestId: string;
  delta: string;
}

/** Host -> Worker: one `parsed_line` event of a relayed stream (see `StreamHandle.lines` in
 *  `GrpcInvoker.ts`) - only sent for requests that set `opts.lineSchema`, interleaved with
 *  `sdk.stream.chunk` messages on the same `requestId`. */
export interface SdkStreamParsedLineMessage {
  type: 'sdk.stream.parsedLine';
  requestId: string;
  parsed: ParsedLine;
}

/** Host -> Worker: one raw (unparsed) line of a relayed stream (see `StreamHandle.rawLines` in
 *  `GrpcInvoker.ts`) - unconditional, does NOT need `opts.lineSchema` (unlike
 *  `SdkStreamParsedLineMessage` above). */
export interface SdkStreamRawLineMessage {
  type: 'sdk.stream.rawLine';
  requestId: string;
  line: string;
}

/** Host -> Worker: one reasoning-model "thinking" text delta of a relayed stream (see
 *  `StreamHandle.reasoning` in `GrpcInvoker.ts`) - separate from `SdkStreamChunkMessage`, which only
 *  ever carries final-answer text. */
export interface SdkStreamReasoningMessage {
  type: 'sdk.stream.reasoning';
  requestId: string;
  text: string;
}

/** Host -> Worker: the stream finished cleanly - `final` is the same aggregated value a unary
 *  `invokeHost()` call would have returned. */
export interface SdkStreamEndMessage {
  type: 'sdk.stream.end';
  requestId: string;
  final: any;
}

/** Host -> Worker: the stream errored, whether or not any chunks were delivered first. */
export interface SdkStreamErrorMessage {
  type: 'sdk.stream.error';
  requestId: string;
  error: SerializedError;
}

/** Worker -> Host: sent once at worker startup after `workerData.pluginsPath` has been loaded -
 *  lets `PluginWorkerHost.start()`/`reload()` fail fast on a broken plugin, same as the
 *  non-sandboxed path's eager `loadPluginModule()` call does today. */
export type ReadyMessage =
  | { type: 'ready'; summary: { id: string; name: string; version: string } }
  | { type: 'load.error'; error: SerializedError };

export type WorkerToHostMessage = InvokeDoneMessage | SdkCallMessage | SdkStreamStartMessage | ReadyMessage;

export type HostToWorkerMessage =
  | InvokeMessage
  | SdkCallResultMessage
  | SdkStreamChunkMessage
  | SdkStreamParsedLineMessage
  | SdkStreamRawLineMessage
  | SdkStreamReasoningMessage
  | SdkStreamEndMessage
  | SdkStreamErrorMessage;

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack, code: (err as any).code };
  }
  return { message: String(err) };
}

export function reviveError(serialized: SerializedError): Error {
  const err = new Error(serialized.message);
  if (serialized.stack) err.stack = serialized.stack;
  if (serialized.code !== undefined) (err as any).code = serialized.code;
  return err;
}
