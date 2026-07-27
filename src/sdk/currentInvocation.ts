import { AsyncLocalStorage } from 'node:async_hooks';
import type { SDKClient } from './SDKClient';

/**
 * Tracks which SDKClient belongs to the plugin invocation currently executing, so the standalone
 * default/per-namespace imports (see globalSdk.ts) can forward to the right instance without the
 * caller having to thread `ctx` through every function. AsyncLocalStorage keeps this correctly
 * isolated across concurrent invocations (each gets its own async context, including across
 * `await` boundaries).
 */
export const invocationStorage = new AsyncLocalStorage<SDKClient>();

export function getCurrentSDK(): SDKClient {
  const client = invocationStorage.getStore();
  if (!client) {
    throw new Error(
      'This import from @aivin-labs/sdk is only usable while main() is running. ' +
        'If you are calling this outside that scope, use ctx.sdk instead.',
    );
  }
  return client;
}
