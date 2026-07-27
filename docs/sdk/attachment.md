# 📎 `attachment` — document/attachment analysis helpers

AI-powered analysis over uploaded documents/attachments: quick search, multi-round deep research
with citations, criteria-based evaluation, natural-language querying of tabular data, and
timestamp-aware querying of media (audio/video) attachments. Reach for this namespace whenever a
plugin needs to reason over files a user has attached rather than raw text passed in `input`.

## Import

```typescript
import { attachment } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.attachment
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `search` | `params: { query: string; limit?: number }` | `Promise<any[]>` | Calls `attachment.search`. Quick search over attachments matching `query`, capped at `limit`. Return shape is an untyped array — no confirmed per-item fields. |
| `upload` | `params: { file: { url: string; name: string; mimeType: string; size: number } }` | `Promise<{ url: string; docId: string }>` | Calls `attachment.upload`. Registers an already-uploaded file (physical upload happens separately, e.g. via `resource.upload`) as a session attachment and kicks off extraction — the returned `docId` is what every other method in this namespace keys on. |
| `deepResearch` | `params: { mission: string; docIds?: string[]; maxRounds?: number }` | `Promise<{ answer: string; citations: { doc_id: string; filename?: string }[]; rounds: number }>` | Calls `attachment.deepResearch`. Multi-round research over one or more documents toward answering `mission`, optionally scoped to specific `docIds` and capped at `maxRounds` rounds. |
| `evaluate` | `params: { criteria: string; docIds?: string[] }` | `Promise<{ summary: string; findings: { aspect: string; assessment: string; severity?: string }[]; doc_ids_used: string[] }>` | Calls `attachment.evaluate`. Evaluates document(s) against a free-text `criteria` string, returning a summary plus a breakdown of per-aspect findings. |
| `queryTabularData` | `params: { docId: string; question: string }` | `Promise<{ answer: string; tables_used: number }>` | Calls `attachment.queryTabularData`. Natural-language Q&A over tabular data (e.g. spreadsheet) inside a single document identified by `docId`. |
| `queryMediaTimestamp` | `params: { docId: string; question: string }` | `Promise<{ answer: string }>` | Calls `attachment.queryMediaTimestamp`. Natural-language Q&A over a media attachment (audio/video), presumably answering with timestamp-aware context, identified by `docId`. |
| `extract` | `params: { docId: string }` | `Promise<{ fileName: string; chunks: { content: string; chunk_index?: number; source?: string }[] }>` | Calls `attachment.extract`. Returns the **raw extracted chunks** of an already-uploaded attachment — no AI summarization/Q&A, just the text the extract-engine already produced during `upload`. Use this when you need the raw content to process yourself instead of asking a question about it. |

## `search` example

```typescript
import { attachment } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const matches = await attachment.search({ query: 'Q3 revenue table', limit: 5 });
  return { status: 'success', data: matches };
}
```

## `deepResearch` example

```typescript
import { attachment } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const research = await attachment.deepResearch({
    mission: 'Summarize all mentioned risk factors and cite the source document for each',
    docIds: input.docIds, // optional - omit to search across all attached docs
    maxRounds: 4,
  });

  // research.answer: string
  // research.citations: { doc_id, filename? }[]
  // research.rounds: number of research rounds actually used
  return { status: 'success', data: research };
}
```

## `evaluate` example

```typescript
import { attachment } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const review = await attachment.evaluate({
    criteria: 'Check this contract for missing termination clauses and unclear payment terms',
    docIds: [input.contractDocId],
  });

  // review.summary: string
  // review.findings: { aspect, assessment, severity? }[]
  // review.doc_ids_used: string[] - which docs the evaluation actually drew from
  return { status: 'success', data: review };
}
```

## `queryTabularData` example

```typescript
import { attachment } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const result = await attachment.queryTabularData({
    docId: input.spreadsheetDocId,
    question: 'What was the total revenue in Q3 across all regions?',
  });

  // result.answer: string
  // result.tables_used: number of tables the answer drew from
  return { status: 'success', data: result };
}
```

## `queryMediaTimestamp` example

```typescript
import { attachment } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const result = await attachment.queryMediaTimestamp({
    docId: input.videoDocId,
    question: 'At what point in the recording does the speaker discuss pricing?',
  });

  // result.answer: string (only field on the return type - no explicit timestamp field is typed)
  return { status: 'success', data: result };
}
```

## `extract` example

```typescript
import { attachment } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const { fileName, chunks } = await attachment.extract({ docId: input.docId });
  const fullText = chunks.map((c) => c.content).join('\n');
  return { status: 'success', data: { fileName, length: fullText.length } };
}
```

`extract` reads back chunks already produced during `upload` — it does **not** re-run extraction
against a fresh file, so it only works for `docId`s that came from a prior `attachment.upload` call
(or any other doc already attached to the current session).

## Notes & caveats

- `search`'s return type is a bare `Promise<any[]>` — unlike the other four methods, there is no
  confirmed per-item shape for search results in `SDKClient.ts`. Treat each result as opaque.
- `deepResearch`, `evaluate`, `queryTabularData`, and `queryMediaTimestamp` all have their return
  shapes explicitly typed in `SDKClient.ts` (reproduced verbatim in the table above) — these are
  more trustworthy than `search`'s untyped array, but are still the client's declared contract,
  not independently backend-verified the way some other namespaces' comments call out.
- `queryMediaTimestamp`'s return type is `{ answer: string }` only — despite the method name
  implying timestamp awareness, there is no separate typed `timestamp` field in the return shape;
  any timestamp information would have to be embedded in the `answer` string itself.
- `docIds` is optional on both `deepResearch` and `evaluate` — omitting it presumably broadens the
  scope to all of the current context's attachments, but that resolution happens server-side.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
