# ⚡ `redis` — isolated key-value cache

`redis` is a simple, isolated key-value cache backed by Redis on the host, scoped to this plugin +
tenant. Reach for it when you need cheap counters, TTL'd flags, or hash-field storage and `store`'s
schema/search/graph features would be overkill.

## Import

```typescript
import { redis } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.redis
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `get` | `key: string` | `Promise<string \| null>` | Read a value; `null` if the key doesn't exist. |
| `set` | `key: string, value: string \| number \| Buffer` | `Promise<'OK'>` | Write a value with no expiry. |
| `setex` | `key: string, seconds: number, value: string \| number \| Buffer` | `Promise<'OK'>` | Write a value that expires after `seconds`. |
| `del` | `...keys: string[]` | `Promise<number>` | Delete one or more keys; returns the number removed. |
| `exists` | `...keys: string[]` | `Promise<number>` | Count how many of the given keys currently exist. |
| `incr` | `key: string` | `Promise<number>` | Increment a numeric key by 1, returning the new value. |
| `incrby` | `key: string, increment: number` | `Promise<number>` | Increment a numeric key by an arbitrary amount. |
| `hget` | `key: string, field: string` | `Promise<string \| null>` | Read one field of a hash. |
| `hset` | `key: string, field: string, value: string \| number` | `Promise<number>` | Set one field of a hash. |
| `hgetall` | `key: string` | `Promise<Record<string, string>>` | Read every field of a hash as a plain object. |
| `hdel` | `key: string, ...fields: string[]` | `Promise<number>` | Delete one or more fields of a hash. |
| `keys` | `pattern: string` | `Promise<string[]>` | List keys matching a glob-style pattern (e.g. `"session:*"`). |

## `set` / `get` / `del` example

```typescript
import { redis } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  await redis.set('last_run_id', input.runId);
  const lastRunId = await redis.get('last_run_id');
  await redis.del('last_run_id');
  return { status: 'success', data: { lastRunId } };
}
```

## `setex` example

```typescript
import { redis } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  // Cache a computed value for 10 minutes.
  await redis.setex(`cache:${input.key}`, 600, JSON.stringify(input.value));
  return { status: 'success' };
}
```

## `exists` example

```typescript
import { redis } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const count = await redis.exists('flag:a', 'flag:b');
  return { status: 'success', data: { existingCount: count } };
}
```

## `incr` / `incrby` example

```typescript
import { redis } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const runsToday = await redis.incr('runs:today');
  const totalTokens = await redis.incrby('tokens:used', input.tokenCount);
  return { status: 'success', data: { runsToday, totalTokens } };
}
```

## `hget` / `hset` / `hgetall` / `hdel` example

```typescript
import { redis } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  await redis.hset('user:prefs', 'theme', 'dark');
  const theme = await redis.hget('user:prefs', 'theme');
  const allPrefs = await redis.hgetall('user:prefs');
  await redis.hdel('user:prefs', 'theme');
  return { status: 'success', data: { theme, allPrefs } };
}
```

## `keys` example

```typescript
import { redis } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const sessionKeys = await redis.keys('session:*');
  return { status: 'success', data: sessionKeys };
}
```

## Notes & caveats

- Namespace confirmed against the backend's real registration — this is **not** a direct Redis
  connection. Docker-runtime plugins never receive raw Redis/Mongo credentials; every call
  goes through the host's `storage.redis*` handlers.
- `del`/`exists`/`hdel` collapse to a single-key wire param when called with exactly one key/field
  (`key: keys[0]`), and to an array when called with more than one (`key: keys`) — purely an
  implementation detail of how the SDK talks to the host, not something you need to branch on in
  your own code.
- `setex` is sugar over the same `storage.redisSet` call as `set`, with `options: { EX: seconds }`
  attached — there is no separate `storage.redisSetex` host method.
- `incrby` is sugar over the same `storage.redisIncr` call as `incr`, with an `amount` param added.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
