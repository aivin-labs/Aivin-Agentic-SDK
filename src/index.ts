/**
 * Aivin Plugin SDK
 *
 * Client library for plugins running inside the Aivin platform's Docker plugin runtime.
 * Talks to the host over gRPC (`SdkTransportService.Invoke`, see src/proto/sdk_transport.proto) -
 * the same RPC the host uses to trigger the plugin's `main()` entry point.
 */

export { SDKClient } from './sdk/SDKClient';
export type { PluginIdentity } from './sdk/SDKClient';

// Default/per-namespace exports (`import { mongo } from '@aivin-labs/sdk'`, etc.) - see
// src/sdk/globalSdk.ts for how these forward to the current invocation.
export * from './sdk/globalSdk';
export { default } from './sdk/globalSdk';

export { PluginServer } from './PluginServer';
export { LocalTestServer } from './LocalTestServer';
export { invokeHost, invokeHostStream, onCall } from './grpc/GrpcInvoker';
export type { CallTrace, StreamHandle } from './grpc/GrpcInvoker';
export { getCurrentTrace, formatTraceForConsole } from './sdk/trace';
export type { InvocationTrace, TraceEvent } from './sdk/trace';

export * from './types/PluginTypes';
export * from './types/SDKTypes';
