# 💰 `usage` — billing & quota info

Read-only accessors for the current tenant's billing balance and consumption/usage stats. Reach
for this when a plugin needs to check remaining credit before doing something expensive (e.g. a
`browser.run()` mission or a large batch of `ai.prompt` calls), or needs to report usage back to
the user.

## Import

```typescript
import { usage } from '@aivin-labs/sdk';
// equally: ctx.sdk.usage / import SDK from '@aivin-labs/sdk'; SDK.usage
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `checkBalance` | `params?: { workspace_id?: string }` | `Promise<any>` | Calls `usage.checkBalance`. Current billing balance/credit for the tenant (or a specific `workspace_id`). |
| `getUsage` | `params?: { workspace_id?: string; period?: string }` | `Promise<any>` | Calls `usage.getUsage`. Consumption/usage stats, optionally scoped to a `workspace_id` and/or a `period`. |

Both methods return `any` in `SDKClient.ts` — no confirmed typed shape for the balance/usage
payload exists in this SDK; treat the result as opaque and inspect the actual fields your tenant
returns at runtime.

## `checkBalance` example

```typescript
import { usage } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const balance = await usage.checkBalance();
  ctx.sdk.log(`Current balance: ${JSON.stringify(balance)}`);
  return { status: 'success', data: balance };
}
```

## `getUsage` example

```typescript
import { usage } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const stats = await usage.getUsage({ period: 'month' });
  return { status: 'success', data: stats };
}
```

## Notes & caveats

- Neither method's return shape is confirmed beyond `any` — there's no backend-verification
  comment for `usage` in `SDKClient.ts` narrowing the payload fields (unlike, say, `attachment`).
- `period` on `getUsage` is typed as a plain `string` with no enumerated set of accepted values in
  `SDKClient.ts` — what strings the backend actually accepts (e.g. `"day"`, `"month"`) is not
  confirmed here; verify against your tenant/backend if precision matters.
- `workspace_id` is optional on both methods — omitting it presumably scopes to the current
  workspace from context, but that resolution happens server-side, not in this client.

## See also

- [SDK Reference](../SDK.md) — the full `ctx.sdk` surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
