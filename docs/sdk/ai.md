# 🧠 `ai` — LLM prompting, embeddings, and reranking

The `ai` namespace is the SDK's interface to the platform's managed LLM stack: text/JSON generation
via `prompt`, embedding generation via `getEmbedding`/`getEmbeddings`, and relevance reranking via
`rerank`. Reach for it whenever your plugin needs model inference without managing its own provider
credentials, rate limits, or model selection — the host resolves all of that server-side.

## Import

```typescript
import { ai } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.ai
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `prompt` | `quest: string \| any[]`, `opts?: LLMPromptOptions` | `Promise<any>` | Run the LLM. `quest` can be a plain question/instruction string or a message-array (e.g. chat-style turns). Maps to `ai.prompt` on the host. |
| `promptStream` | `quest: string \| any[]`, `opts?: LLMPromptOptions` | `{ textStream: AsyncIterable<string>, text: Promise<string> }` | Streaming counterpart of `prompt` — text deltas arrive as the model generates them instead of waiting for the whole response. Maps to `ai.promptStream` on the host, over a dedicated server-streaming gRPC RPC (`InvokeStream`), not the plain unary `Invoke` every other call here uses. |
| `getEmbedding` | `text: string \| string[]`, `opts?: LLMPromptOptions` | `Promise<Float32Array \| Float32Array[]>` | Single embedding call. Pass a string for one vector back, or a string array for an array of vectors back (shape of return mirrors shape of input). |
| `getEmbeddings` | `texts: string[]`, `opts?: LLMPromptOptions` | `Promise<Float32Array[]>` | Batch embeddings — faster than looping `getEmbedding` per string. **`texts` is a bare array, not wrapped in an object** — this differs from `CodeSDK.d.ts`'s declared `getEmbeddings({texts, opts})` shape, which does not match the real backend. |
| `rerank` | `query: string`, `docs: string[]`, `opts?: any` | `Promise<{ index: number; score: number }[]>` | Re-ranks `docs` by relevance to `query`. Returns one `{index, score}` entry per input doc, `index` referring back into the original `docs` array — **not** the reranked documents themselves. `opts` is accepted by the SDK signature but **currently ignored by the host** — the backend handler calls its reranker with `(query, docs)` only, so options like `top_k` have no effect today. |
| `tts` | `text: string`, `opts?: Record<string, any>` | `Promise<any>` | Text-to-speech. Maps to `ai.tts` on the host. |
| `stt` | `audio: any`, `opts?: Record<string, any>` | `Promise<any>` | Speech-to-text. Maps to `ai.stt` on the host. |
| `getModels` | `provider?: string` | `Promise<any>` | Lists available models, optionally filtered by `provider`. Maps to `ai.getModels`. |
| `calculateTokens` | `data: Record<string, any>` | `Promise<any>` | Estimates token usage for a given prompt/payload without making a real LLM call. Maps to `ai.calculateTokens`. |

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
import { ai } from '@aivin-labs/sdk';

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
import { ai } from '@aivin-labs/sdk';

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

### Streaming with `promptStream`

Same shape as Vercel AI SDK's `streamText()` — a `textStream` you can iterate for incremental
deltas, and a `text` promise for the full result:

```typescript
import { ai, call } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const result = ai.promptStream(`Write a short summary of: ${input.text}`);

  for await (const delta of result.textStream) {
    // e.g. forward progress to the user via realtime.publish as it's generated
    await call('realtime.publish', { event: 'summary.progress', data: delta });
  }

  const summary = await result.text; // full text, resolves once the stream ends
  return { status: 'success', data: summary };
}
```

`text` resolves correctly even if you never iterate `textStream` — the stream drains from the
network as soon as `promptStream()` is called, independent of whether/how fast you consume it.
Falls back to a single "chunk" (the whole response, then done) if the model/provider resolved
server-side doesn't support token-level streaming; `textStream`/`text` behave the same either way.
No automatic retry on transport failure mid-stream (unlike every other call in this SDK) — see
[CHANGELOG](../CHANGELOG.md) for why.

## `getEmbedding` / `getEmbeddings` example

```typescript
import { ai } from '@aivin-labs/sdk';

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
import { ai } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const docs = input.candidates as string[];
  const ranked = await ai.rerank(input.query, docs);

  // ranked entries reference the original docs array by index;
  // slice yourself if you only want the top N — opts like top_k are ignored by the host
  const ordered = ranked
    .map((r) => ({ text: docs[r.index], score: r.score }))
    .slice(0, 5);

  return { status: 'success', data: ordered };
}
```

## Notes & caveats

- Param shapes here are verified against the backend's real `get ai()` in `src/base/SDK.ts`, **not**
  just `CodeSDK.d.ts` — the declared type file diverges from the real implementation in at least two
  places: it declares `getEmbeddings({texts, opts})` (object-wrapped) when the real code takes
  `getEmbeddings(texts, opts)` (bare array first arg), and it declares `rerank(query, docs, ...opts)`
  (spread) when the real code nests rerank options under a single `opts` object.
- `tts`/`stt`/`getModels`/`calculateTokens` are confirmed against `AISDK.ts`'s `register(...)` calls
  on the backend — exact return shapes are otherwise untyped (`Promise<any>`).
- `rerank`'s `opts` is accepted client-side but **dropped server-side** (see the method table) — do
  not rely on any field in it; post-process the returned `{index, score}` list yourself instead.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
