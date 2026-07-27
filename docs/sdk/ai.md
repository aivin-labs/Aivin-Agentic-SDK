# 🧠 `ai` — LLM prompting, embeddings, and reranking

The `ai` namespace is the SDK's interface to the platform's managed LLM stack: text/JSON generation
via `prompt`, embedding generation via `getEmbedding`/`getEmbeddings`, and relevance reranking via
`rerank`. Reach for it whenever your plugin needs model inference without managing its own provider
credentials, rate limits, or model selection — the host resolves all of that server-side.

## Import

```typescript
import { ai } from '@aivin/sdk';
// equally: ctx.sdk.ai / import SDK from '@aivin/sdk'; SDK.ai
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `prompt` | `quest: string \| any[]`, `opts?: LLMPromptOptions` | `Promise<any>` | Run the LLM. `quest` can be a plain question/instruction string or a message-array (e.g. chat-style turns). Maps to `ai.prompt` on the host. |
| `getEmbedding` | `text: string \| string[]`, `opts?: LLMPromptOptions` | `Promise<Float32Array \| Float32Array[]>` | Single embedding call. Pass a string for one vector back, or a string array for an array of vectors back (shape of return mirrors shape of input). |
| `getEmbeddings` | `texts: string[]`, `opts?: LLMPromptOptions` | `Promise<Float32Array[]>` | Batch embeddings — faster than looping `getEmbedding` per string. **`texts` is a bare array, not wrapped in an object** — this differs from `CodeSDK.d.ts`'s declared `getEmbeddings({texts, opts})` shape, which does not match the real backend. |
| `rerank` | `query: string`, `docs: string[]`, `opts?: any` | `Promise<{ index: number; score: number }[]>` | Re-ranks `docs` by relevance to `query`. Returns one `{index, score}` entry per input doc, `index` referring back into the original `docs` array — **not** the reranked documents themselves. `opts` is nested as a single object (not spread as `{query, docs, ...opts}` — that's `CodeSDK.d.ts`'s wrong, unimplemented shape). |

`LLMPromptOptions` (from `src/types/SDKTypes.ts`), applies to `prompt`, `getEmbedding`, and
`getEmbeddings`:

| Field | Type | Notes |
| --- | --- | --- |
| `instructions` | `string` | Extra system-style guidance layered onto the call. |
| `schema` | `Record<string, any>` | Forces structured/JSON output matching this schema. |
| `rules` | `string` | Additional constraints for the model to follow. |
| `style` | `string` | Tone/style guidance. |
| `model` | `string` | Explicit model override; omit to use the platform default. |
| `temperature` | `number` | Sampling temperature. |
| `max_tokens` | `number` | Output token cap. |
| `reasoning` | `'disabled' \| 'low' \| 'medium' \| 'high'` | Reasoning-effort dial, where the underlying model supports it. |
| `websearch` | `'none' \| 'low' \| 'medium' \| 'high'` | Lets the model pull in live web search results before answering. |

## `prompt` example

```typescript
import { ai } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  const summary = await ai.prompt(`Summarize this ticket:\n${input.text}`, {
    instructions: 'Reply in 2 sentences, plain English, no markdown.',
    model: 'gpt-4o-mini',
    temperature: 0.2,
  });
  return { status: 'success', data: summary };
}
```

### Structured output with `schema`

```typescript
import { ai } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  const result = await ai.prompt(`Extract fields from: ${input.text}`, {
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['title', 'priority'],
    },
  });
  return { status: 'success', data: result };
}
```

## `getEmbedding` / `getEmbeddings` example

```typescript
import { ai } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  // Single string in -> single vector out
  const vec = await ai.getEmbedding(input.text);

  // Batch — prefer this over looping getEmbedding per item
  const vectors = await ai.getEmbeddings(input.items.map((i) => i.text));

  return { status: 'success', data: { vec, count: vectors.length } };
}
```

## `rerank` example

```typescript
import { ai } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  const docs = input.candidates as string[];
  const ranked = await ai.rerank(input.query, docs, { top_k: 5 });

  // ranked entries reference the original docs array by index
  const ordered = ranked.map((r) => ({ text: docs[r.index], score: r.score }));

  return { status: 'success', data: ordered };
}
```

## Notes & caveats

- Param shapes here are verified against the backend's real `get ai()` in `src/base/SDK.ts`, **not**
  just `CodeSDK.d.ts` — the declared type file diverges from the real implementation in at least two
  places: it declares `getEmbeddings({texts, opts})` (object-wrapped) when the real code takes
  `getEmbeddings(texts, opts)` (bare array first arg), and it declares `rerank(query, docs, ...opts)`
  (spread) when the real code nests rerank options under a single `opts` object.
- `tts`, `stt`, `getModels`, and `calculateTokens` are **not** present on the real `ai` sugar object,
  despite appearing plausible/expected. If you need them, call `call('ai.tts', ...)`,
  `call('ai.stt', ...)`, etc. directly via the generic escape hatch — but their exact parameter
  shape is unconfirmed against the backend, so treat them as unverified until you've checked.
- `rerank`'s `opts` type is `any` in `SDKClient.ts` — there is no confirmed field list for it beyond
  "an options object passed through as-is."

## See also

- [SDK Reference](../SDK.md) — the full `ctx.sdk` surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
