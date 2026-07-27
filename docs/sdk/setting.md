# ⚙️ `setting` — tenant display & merchant configuration

Read-only accessors for the current tenant's display settings and merchant configuration. Use this
namespace when a plugin needs to adapt output to the workspace's configured language or pull
merchant-level config (e.g. billing/store setup) rather than its own plugin config (that's
`ctx.sdk.workspace.getPluginConfig`, not `setting`).

## Import

```typescript
import { setting } from '@aivin/sdk';
// equally: ctx.sdk.setting / import SDK from '@aivin/sdk'; SDK.setting
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `get` | `params?: { lang?: string }` | `Promise<any>` | Calls `setting.getSetting`. Fetches the tenant's display settings, optionally localized to `lang`. |
| `getMerchantConfig` | `params?: Record<string, never>` | `Promise<any>` | Calls `setting.getMerchantConfig`. Fetches merchant-level configuration. Note the param type is `Record<string, never>` — i.e. the signature only accepts an empty object or `undefined`, no actual fields are passed through. |

Both methods return `any` in `SDKClient.ts` — there is no confirmed typed shape for the setting or
merchant-config payload in this SDK; treat the result as an opaque object and narrow it yourself
based on what your workspace actually returns.

## `get` example

```typescript
import { setting } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  const settings = await setting.get({ lang: 'vi' });
  return { status: 'success', data: settings };
}
```

## `getMerchantConfig` example

```typescript
import { setting } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  // No fields are accepted here per the SDKClient.ts signature - call with no args or `{}`.
  const merchantConfig = await setting.getMerchantConfig();
  return { status: 'success', data: merchantConfig };
}
```

## Notes & caveats

- `getMerchantConfig`'s parameter type is `Record<string, never>` in `SDKClient.ts` — this is a
  TypeScript way of saying "an object with no properties." In practice, call it with no arguments
  or `{}`; passing real fields isn't part of the declared contract.
- Neither method has a documented return shape beyond `any` — unlike `attachment` or `browser`,
  there's no backend-verification comment in `SDKClient.ts` narrowing what fields come back.
- This is distinct from `ctx.sdk.workspace.getPluginConfig({ plugin_id, workspace_id? })`, which
  reads *your plugin's* saved per-workspace config, not tenant-wide display/merchant settings.

## See also

- [SDK Reference](../SDK.md) — the full `ctx.sdk` surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
