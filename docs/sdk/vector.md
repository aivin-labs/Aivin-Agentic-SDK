# 🔎 `vector` — raw document vector search & indexing

The `vector` namespace is the SDK's interface to the workspace's Milvus-backed vector store for raw
document search (RAG) — indexing content (`index`) and similarity-searching it back out
(`search`). Use it when you're building your own retrieval pipeline over ad-hoc content, as opposed
to [`knowledge`](./knowledge.md)'s curated long-term knowledge base.

## Import

```typescript
import { vector } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.vector
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `search` | `params: { query: string; type?: string; limit?: number; threshold?: number }` | `Promise<any[]>` | Raw similarity search over the workspace's document cluster. Maps to `vector.searchDocuments`; `params` is passed through as a single object, unmodified. |
| `index` | `params: { content: string; type?: string; id?: string; metadata?: Record<string, unknown> }` | `Promise<void>` | Indexes `content` for later vector search. Maps to `vector.indexDocument`; `params` is passed through as a single object, unmodified. |

## `search` example

```typescript
import { vector } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const hits = await vector.search({
    query: input.question,
    type: 'faq',
    limit: 10,
    threshold: 0.7,
  });

  return { status: 'success', data: hits };
}
```

## `index` example

```typescript
import { vector } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  await vector.index({
    id: input.docId,
    content: input.text,
    type: 'faq',
    metadata: { source: 'support-ticket', ticket_id: input.ticketId },
  });

  return { status: 'success' };
}
```

## Notes & caveats

- Both methods take a **single params object**, not positional arguments — `search(params)` and
  `index(params)` pass their object straight through to `vector.searchDocuments` /
  `vector.indexDocument` on the host without reshaping.
- `type` on both methods is a free-form string used to scope/tag documents (e.g. `'faq'`,
  `'transcript'`) — there is no fixed enum confirmed in `SDKClient.ts`; it's typed as plain
  `string?`.
- `index` returns `Promise<void>` — the host does not hand back the generated document ID in the
  resolved value, so if you need to reference the indexed document again, generate and pass your
  own `id` up front.
- This is the raw/low-level vector store, separate from the curated `knowledge` namespace — pick
  whichever matches your retrieval model (bring-your-own-content vs. curated workspace knowledge).

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
