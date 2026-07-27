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

- **Only `search` is confirmed** against the real `get knowledge()` in `src/base/SDK.ts`. The
  `store`/`get`/`del`/`reinforce` methods that appear in `CodeSDK.d.ts` have **no confirmed real
  implementation** on the backend and were deliberately removed from `SDKClient.ts`'s sugar object
  rather than risk shipping a wrong parameter shape.
- If you need write/delete/reinforce behavior, call the underlying namespace directly via the
  generic escape hatch — e.g. `call('knowledge.storeKnowledge', ...)` — but treat its parameter
  shape as **unconfirmed** until verified against the backend; don't assume it mirrors `search`'s
  shape or `CodeSDK.d.ts`'s declared shape.
- `opts.workspace_id` lets you target a workspace other than the current one, if permitted; omit it
  to search the invoking workspace.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
