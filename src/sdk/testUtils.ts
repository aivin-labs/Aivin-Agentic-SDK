import { SDKClient, type PluginIdentity } from './SDKClient';
import { invocationStorage } from './currentInvocation';
import type { InvokeRequest } from '../grpc/GrpcInvoker';
import type { PluginContext } from '../types/SDKTypes';

export interface MockSDKHandlers {
  /** Keyed by `namespace.method` (e.g. `'ai.prompt'`, `'store.set'`) - matches exactly what
   *  `call('namespace.method', params)` sends, so copy the namespace/method straight out of the
   *  relevant `docs/sdk/*.md` page or the error message a missing handler throws. */
  [namespaceMethod: string]: (params: any) => any | Promise<any>;
}

export interface CreateMockSDKOptions {
  /** Overrides for the fake `user`/`workspace`/`session`/`client` this mock client reports -
   *  defaults are a plausible single test tenant, override only what your test actually asserts on. */
  identity?: Partial<PluginIdentity>;
  /** One handler per `namespace.method` your plugin code is expected to call during this test.
   *  Calling anything NOT listed here throws immediately with a clear message naming the missing
   *  namespace - this is deliberate: a plugin silently getting `undefined` back from an unmocked
   *  call is a much worse debugging experience than a test failing loudly at the exact call site. */
  handlers?: MockSDKHandlers;
}

export interface MockSDK {
  /** Pass this as `ctx.sdk` (or bind it with `withMockSDK` to also cover the recommended
   *  `import { ai } from '@aivin-labs/sdk'` top-level style - see that function's doc). */
  client: SDKClient;
  /** Every call made through `client` during the test, in order - inspect this instead of (or
   *  alongside) individual handler return values to assert on the params a call actually sent. */
  calls: Array<{ namespace: string; params: any }>;
}

/**
 * Builds a fake `SDKClient` for unit-testing plugin logic - no real gRPC round trip, no running
 * backend required. Mirrors the pattern `test/sdkClient.test.ts` already uses internally
 * (`SDKClientOptions.invoke`), packaged for plugin authors instead of just this package's own tests.
 *
 * ```typescript
 * import { createMockSDK, withMockSDK } from '@aivin-labs/sdk';
 * import { main } from '../src/main';
 *
 * test('summarizes and returns success', async () => {
 *   const { client, calls } = createMockSDK({
 *     handlers: { 'ai.prompt': async ({ quest }) => `Summary of: ${quest}` },
 *   });
 *   const ctx = { sdk: client, user: client_identity_if_needed } as any;
 *
 *   const result = await withMockSDK(client, () => main('test', { text: 'long text' }, ctx));
 *
 *   assert.equal(result.status, 'success');
 *   assert.equal(calls[0].namespace, 'ai.prompt');
 * });
 * ```
 */
export function createMockSDK(options: CreateMockSDKOptions = {}): MockSDK {
  const calls: Array<{ namespace: string; params: any }> = [];

  const invoke = async (req: InvokeRequest) => {
    calls.push({ namespace: req.namespace, params: req.params });
    const handler = options.handlers?.[req.namespace];
    if (!handler) {
      const known = Object.keys(options.handlers ?? {});
      throw new Error(
        `[createMockSDK] no handler registered for '${req.namespace}'. Add it to createMockSDK({ handlers: { '${req.namespace}': (params) => ... } }).` +
          (known.length ? ` Handlers currently registered: ${known.join(', ')}.` : ' No handlers registered at all.'),
      );
    }
    return handler(req.params);
  };

  const identity: PluginIdentity = {
    user: { id: 'test-user', client: 'test', name: 'Test User' } as any,
    workspace: { id: 'test-workspace', client: 'test', name: 'Test Workspace', key: 'test' } as any,
    session: {} as any,
    client: 'test',
    ...options.identity,
  };

  const client = new SDKClient(identity, { cap: 'mock-cap-token', invoke });
  return { client, calls };
}

/**
 * Runs `fn` with `sdk` bound as the ambient client for this async context - so the RECOMMENDED
 * `import { ai } from '@aivin-labs/sdk'` top-level style resolves to your mock inside `fn`, exactly
 * how a real invocation binds one via `PluginServer.executeHandler`. Without this, a mock SDK passed
 * only as `ctx.sdk` never gets exercised by code written the way this SDK's own docs/scaffolds tell
 * you to write it - `ctx.sdk` is documented as the legacy path.
 *
 * Wrap the whole call to your plugin's `main()` (or any function it transitively calls) in this.
 */
export function withMockSDK<T>(sdk: SDKClient, fn: () => T | Promise<T>): Promise<T> {
  return invocationStorage.run(sdk, async () => fn());
}

/**
 * Builds a `PluginContext` (the 3rd argument to `main(mission, input, ctx)`) around a mock client -
 * saves re-typing the same `user`/`workspace` boilerplate `ctx` needs at every test call site.
 * `sdk` is required, not defaulted, so it's obvious in the test which mock (and which `calls` array)
 * a given context is wired to.
 */
export function createMockContext(
  sdk: SDKClient,
  overrides: Partial<Omit<PluginContext, 'sdk'>> = {},
): PluginContext {
  return {
    sdk,
    user: { id: 'test-user', client: 'test', name: 'Test User' } as any,
    workspace: { id: 'test-workspace', client: 'test', name: 'Test Workspace', key: 'test' } as any,
    ...overrides,
  } as PluginContext;
}
