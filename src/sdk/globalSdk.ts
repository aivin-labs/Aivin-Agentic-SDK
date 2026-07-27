import { getCurrentSDK } from './currentInvocation';
import type { SDKClient } from './SDKClient';

/**
 * The documented way to reach the platform:
 *
 *   import { mongo } from '@aivin-labs/sdk'; mongo.model('users').find({...})
 *
 * (`ctx.sdk` and the default export reach the exact same per-invocation SDKClient - same
 * capability token, same tenant scoping - but both are legacy: still supported, no longer shown
 * in docs or scaffolds.)
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

/** Default export - the whole client as one object. Kept for backwards compatibility;
 *  not documented anymore: docs/scaffolds only show per-namespace imports. */
export default sdkClient;

// ── Per-namespace named exports - `import { mongo, redis, ai } from '@aivin-labs/sdk'` ────────────
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
export const code = bindNamespace('code');
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

// ── Top-level method exports - `import { ask, hil, call } from '@aivin-labs/sdk'` ──────────────────
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
// A function (not a re-exported getter) - module exports bind once at import time, but the
// underlying value is per-invocation, so it has to be read lazily on every call.
export function config(): Record<string, any> {
  return getCurrentSDK().config;
}
