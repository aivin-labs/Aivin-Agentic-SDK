# 🗂️ `datasource` — training data source management

The `datasource` namespace lets a plugin inspect and trigger learning from the workspace's
configured training data sources (e.g. connected knowledge feeds) and browse the knowledge domains
derived from them. Reach for it when your plugin needs to enumerate what the workspace has already
connected for training, or kick off a (re-)learn pass on a specific source.

## Import

```typescript
import { datasource } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.datasource
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `getSources` | `params?: { scope?: any }` | `Promise<any[]>` | Lists the workspace's configured training data sources. Maps to `datasource.getTrainingSourceList`. |
| `getDomains` | `params?: { scope?: any }` | `Promise<any[]>` | Lists the knowledge domains derived from training sources. Maps to `datasource.getKnowledgeDomains`. |
| `learn` | `params: { source_id: string }` | `Promise<any>` | Triggers a learn/re-learn pass for the given source. Maps to `datasource.learnFrom`. |

## `getSources` / `getDomains` example

```typescript
import { datasource } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const sources = await datasource.getSources();
  const domains = await datasource.getDomains({ scope: { workspace_id: ctx.workspace?.id } });

  return { status: 'success', data: { sources, domains } };
}
```

## `learn` example

```typescript
import { datasource } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const source = (await datasource.getSources())[0];
  if (!source) {
    return { status: 'error', data: 'No training sources configured' };
  }

  const result = await datasource.learn({ source_id: source.id });
  return { status: 'success', data: result };
}
```

## Notes & caveats

- `scope` on `getSources`/`getDomains` is typed as `any` in `SDKClient.ts` — there is no confirmed
  fixed shape for it beyond "an optional scoping object"; treat its exact fields as unconfirmed and
  inspect what a returned source/domain object looks like at runtime before relying on specific
  sub-fields.
- `learn`'s return value is typed `any` — the shape of the learn-job result is not pinned down in
  `SDKClient.ts`; don't assume specific fields without confirming against actual responses.
- This namespace has no documented delete/create-source method in `SDKClient.ts` — only
  list-sources, list-domains, and trigger-learn are exposed as sugar.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
