import { getCurrentSDK } from './currentInvocation';
import type { SDKClient } from './SDKClient';

/**
 * Two equivalent ways to reach the platform, both backed by the exact same per-invocation
 * SDKClient (same capability token, same tenant scoping) - pick whichever reads best:
 *
 *   ctx.sdk.mongo.model('users').find({...})              // via ctx (3rd arg of main())
 *   import SDK from '@aivin/sdk'; SDK.mongo.model(...)      // default import
 *   import { mongo } from '@aivin/sdk'; mongo.model(...)    // import just the namespace you need
 *
 * All of these are Proxy objects that resolve `getCurrentSDK()` fresh on every property access -
 * there's no single shared instance, since a new SDKClient (bound to a fresh capability token) is
 * created for every invocation. Accessing one outside of a running `main()` throws a clear error.
 */
function bindNamespace<K extends keyof SDKClient>(namespace: K): SDKClient[K] {
  return new Proxy({} as any, {
    get(_target, prop) {
      const value = (getCurrentSDK()[namespace] as any)[prop];
      return typeof value === 'function' ? value.bind(getCurrentSDK()[namespace]) : value;
    },
    has(_target, prop) {
      return prop in (getCurrentSDK()[namespace] as any);
    },
  });
}

const sdkClient: SDKClient = new Proxy({} as SDKClient, {
  get(_target, prop) {
    const client = getCurrentSDK() as any;
    const value = client[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  },
  has(_target, prop) {
    return prop in (getCurrentSDK() as any);
  },
}) as SDKClient;

/** `import SDK from '@aivin/sdk'` - the whole client as one object. */
export default sdkClient;

// ── Per-namespace named exports - `import { mongo, redis, ai } from '@aivin/sdk'` ────────────
export const ai = bindNamespace('ai');
export const knowledge = bindNamespace('knowledge');
export const vector = bindNamespace('vector');
export const datasource = bindNamespace('datasource');
export const causality = bindNamespace('causality');
export const attachment = bindNamespace('attachment');
export const workspace = bindNamespace('workspace');
export const agent = bindNamespace('agent');
export const browser = bindNamespace('browser');
export const project = bindNamespace('project');
export const datastore = bindNamespace('datastore');
export const task = bindNamespace('task');
export const message = bindNamespace('message');
export const notification = bindNamespace('notification');
export const realtime = bindNamespace('realtime');
export const queue = bindNamespace('queue');
export const usage = bindNamespace('usage');
export const automation = bindNamespace('automation');
export const resource = bindNamespace('resource');
export const session = bindNamespace('session');
export const file = bindNamespace('file');
export const setting = bindNamespace('setting');
export const store = bindNamespace('store');
export const redis = bindNamespace('redis');
export const mongo = bindNamespace('mongo');

// ── Top-level method exports - `import { ask, hil, call } from '@aivin/sdk'` ──────────────────
export function call(func: string, params?: any, timeoutMs?: number) {
  return getCurrentSDK().call(func, params, timeoutMs);
}
export function ask(question: string, schema?: Record<string, any>) {
  return getCurrentSDK().ask(question, schema);
}
export function hil(key: string, prompt: string, options?: Parameters<SDKClient['hil']>[2]) {
  return getCurrentSDK().hil(key, prompt, options);
}
export function a2a<T = unknown>(
  target: string,
  data: Record<string, unknown>,
  purpose: string,
): Promise<T> {
  return getCurrentSDK().a2a(target, data, purpose);
}
export function log(msg: string, level?: 'info' | 'warn' | 'error') {
  return getCurrentSDK().log(msg, level);
}
export function wait(ms: number) {
  return getCurrentSDK().wait(ms);
}
export function user(id: string) {
  return getCurrentSDK().user(id);
}
