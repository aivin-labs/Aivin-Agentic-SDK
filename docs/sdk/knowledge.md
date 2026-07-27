# 📚 `knowledge` — workspace long-term knowledge base search

The `knowledge` namespace lets a plugin query the workspace's persistent, curated knowledge base
(distinct from raw vector search over documents — see [`vector`](./vector.md)). Reach for it when
you need previously-learned or curated facts/answers for the current workspace rather than a
similarity search over indexed content.

## Import

```typescript
import { knowledge } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.knowledge
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `search` | `query: string`, `opts?: { workspace_id?: string; limit?: number; threshold?: number }` | `Promise<any[]>` | Searches the workspace's long-term knowledge base for entries relevant to `query`. Maps to `knowledge.searchKnowledge` on the host, with `opts` fields spread directly into the call params (not nested). |
| `store` | `knowledge: any`, `scope?: Record<string, any>` | `Promise<any>` | Persists a new knowledge entry into the workspace's long-term store. Maps to `knowledge.storeKnowledge`; `client`/`orgId`/`workspaceId` are always resolved server-side from `ctx`, not from `scope`. |
| `reinforce` | `ids: string[]` | `Promise<any>` | Boosts the relevance/recency signal of existing knowledge entries by ID. Maps to `knowledge.reinforceKnowledge`. |

## `search` example

```typescript
import { knowledge } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const results = await knowledge.search(input.question, {
    limit: 5,
    threshold: 0.75,
  });

  return { status: 'success', data: results };
}
```

## Notes & caveats

- `search`/`store`/`reinforce` are confirmed against `BrainSDK.ts`'s `registerKnowledgeHandlers()`
  on the backend. `get`/`del` (from `CodeSDK.d.ts`) have no confirmed real implementation on the
  sugar object — use `call('knowledge.batchGetKnowledge', ...)` / `call('knowledge.batchDeleteKnowledge', ...)`
  directly if you need them.
- `store`'s `client`/`orgId`/`workspaceId` are always resolved server-side from the caller's `ctx` —
  passing them in `scope` will not let you write into a different workspace/tenant than the current one.
- `opts.workspace_id` lets you target a workspace other than the current one, if permitted; omit it
  to search the invoking workspace.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
