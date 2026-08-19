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
| `prompt` | `quest: string \| any[]`, `opts?: LLMPromptOptions`, `driver?: MessageListener \| NodeJS.WritableStream` | `Promise<any>` | Run the LLM. `quest` can be a plain question/instruction string or a message-array (e.g. chat-style turns). What `driver` (3rd param) **is** decides the mode: omitted → plain unary call (unchanged from before this existed, never opens a stream); a `Writable`-shaped value (`.write()`/`.end()` - a Node stream, an HTTP response, a `PassThrough`) → text deltas get written into it, `.end()`/`.destroy(err)` called for you; a `MessageListener` → callbacks fire as data arrives. All 3 resolve to the same final aggregated value — see [Streaming and piping with `prompt()`'s 3rd param](#streaming-and-piping-with-prompts-3rd-param) below. |
| `promptStream` | `quest: string \| any[]`, `opts?: LLMPromptOptions` | `{ textStream: AsyncIterable<string>, text: Promise<string>, lines: AsyncIterable<ParsedLine> }` | Pull-based counterpart of `prompt()` — same streaming transport, `AsyncIterable`s instead of a `driver` 3rd arg. Use this when you want to `for await` the result yourself or compose it with other iterable-based tooling (`Readable.from(result.textStream)`, async generator pipelines) instead of pushing into an existing stream object. |
| `cancel` | `requestId: string` | `Promise<{ cancelled_locally: boolean }>` | Cancels an in-flight `prompt()`/`promptStream()` call started with the same `opts.request_id` — from a completely different invocation/process than the one that started it. See [Cancelling from elsewhere with `request_id`](#cancelling-from-elsewhere-with-request_id) below. |
| `getEmbedding` | `text: string \| string[]`, `opts?: LLMPromptOptions` | `Promise<Float32Array \| Float32Array[]>` | Single embedding call. Pass a string for one vector back, or a string array for an array of vectors back (shape of return mirrors shape of input). |
| `getEmbeddings` | `texts: string[]`, `opts?: LLMPromptOptions` | `Promise<Float32Array[]>` | Batch embeddings — faster than looping `getEmbedding` per string. **`texts` is a bare array, not wrapped in an object** — this differs from the SDK's own declared `getEmbeddings({texts, opts})` shape, which does not match the real backend. |
| `rerank` | `query: string`, `docs: string[]`, `opts?: any` | `Promise<{ index: number; score: number }[]>` | Re-ranks `docs` by relevance to `query`. Returns one `{index, score}` entry per input doc, `index` referring back into the original `docs` array — **not** the reranked documents themselves. `opts` is accepted by the SDK signature but **currently ignored by the host** — the backend handler calls its reranker with `(query, docs)` only, so options like `top_k` have no effect today. |
| `tts` | `text: string`, `opts?: Record<string, any>` | `Promise<any>` | Text-to-speech. Maps to `ai.tts` on the host. |
| `stt` | `audio: any`, `opts?: Record<string, any>` | `Promise<any>` | Speech-to-text. Maps to `ai.stt` on the host. |
| `getModels` | `provider?: string` | `Promise<any>` | Lists available models, optionally filtered by `provider`. Maps to `ai.getModels`. |
| `calculateTokens` | `data: Record<string, any>` | `Promise<any>` | Estimates token usage for a given prompt/payload without making a real LLM call. Maps to `ai.calculateTokens`. |
| `ocr` | `image: MediaItem` | `Promise<string>` | Extracts text from an image. `image` needs either a real `url` or `file` (base64 dataURL/Buffer) — `id` is caller-chosen, not looked up server-side. |
| `image` | `prompt: string`, `opts?: MediaPromptOptions` | `Promise<MediaGenerationResult>` | Generates an image from a text prompt. See [Generating images and video](#generating-images-and-video-with-ocr-image-video) below — set `opts.max_cost_usd` unless cost is a non-concern. |
| `video` | `prompt: string`, `opts?: MediaPromptOptions` | `Promise<MediaGenerationResult>` | Generates a video from a text prompt — same options as `image`, slower and more expensive. |

`LLMPromptOptions` (from `src/types/SDKTypes.ts`), applies to `prompt`, `getEmbedding`, and
`getEmbeddings`:

| Field | Type | Notes |
| --- | --- | --- |
| `instructions` | `string` | Task-specific persona/role guidance — the instruction field most callers want. See [Instruction fields](#instruction-fields-instructions-vs-base_instruction-vs-dynamic_instruction-vs-format_instruction) below for how it composes with the other three. |
| `base_instruction` | `string` | Most-static platform/system-level rules, assembled ahead of `instructions`. Rarely needed from plugin code. |
| `dynamic_instruction` | `string` | RAG/context/history guidance that changes every turn — kept in a separate cache-friendly block from `instructions`/`base_instruction`/`rules`/`style`. |
| `format_instruction` | `any` | Explicit override for the output-format instruction text — skips the host's own auto-generated format text (including `schema`'s). Rarely needed; `schema` alone already generates an accurate one. |
| `schema` | `Record<string, any>` | Forces structured/JSON output matching this schema, using the platform's Custom Schema DSL (`"type - description"` strings, not raw JSON Schema) — see [Structured output with `schema`](#structured-output-with-schema) below. |
| `rules` | `string` | Additional constraints for the model to follow. |
| `style` | `string` | Tone/style guidance. |
| `role` | `string` | Persona the model should adopt (`'expert'`, `'ai_staff'`, ...) — assembled as `Embody the persona of: {role}` right after `instructions`. A hint string, not an enforced enum. |
| `context` | `any` | Freeform background data for the model to draw on — unlike `instructions` (guidance about HOW to respond), this is DATA. |
| `history` | `any[]` | Prior conversation turns, for multi-turn context. |
| `reference` | `string` | Reference material/source text to ground the response in. |
| `tier` | `'xhard' \| 'hard' \| 'medium' \| 'light' \| 'nano' \| 'code' \| 'vl'` | **Prefer this over `model`.** Lets the host resolve a live model for you, with real fallback — see [Choosing a tier](#choosing-a-tier) below. Omit both `tier` and `model` and the host defaults to `light`. |
| `quality` | `number` | Only with `tier` — caps eligible models by price (0-5, lower = cheaper). Omit to use the tier's own declared order. |
| `priority` | `'high' \| 'normal' \| 'low'` | Queuing priority under load — doesn't affect which model gets picked. |
| `model` | `string` | Pins one exact model, **bypassing `tier`'s live-availability resolution and fallback cascade** — if this model is offline, the call just fails. Only reach for this when you need a specific model's capability; use `tier` for everything else. |
| `temperature` | `number` | Sampling temperature. |
| `max_tokens` | `number` | Output token cap. |
| `reasoning` | `'disabled' \| 'low' \| 'medium' \| 'high'` | Reasoning-effort dial, where the underlying model supports it. |
| `websearch` | `'none' \| 'low' \| 'medium' \| 'high'` | Lets the model pull in live web search results before answering. |
| `images` | `MediaItem[]` | Images to attach, for a vision-capable model (`tier: 'vl'`, or any model that supports image input). |
| `files` | `MediaItem[]` | Files to attach — support depends on the resolved model/provider. |
| `audio` | `MediaItem` | Audio input, for a model/route that accepts it directly (distinct from the separate `ai.stt` call). |
| `video` | `MediaItem` | Video input, for a model/route that accepts it directly. |
| `no_fallback` | `boolean` | Only with an explicit `model` (no `tier`) — removes the one safety-net exception that call would otherwise get (auto-retry on a fallback model for an infra-level error). No effect on a `tier`-resolved call, which always retries on error regardless. |
| `allow_fallback` | `boolean` | Only with an explicit `model` (no `tier`) — the opposite of `no_fallback`: forces the SAME auto-retry-on-any-error a `tier`-resolved call gets for free. This is a sequential retry (next candidate only after the current one errors), not a parallel race. |
| `lineSchema` | `LineTemplate \| Record<string, string>` | Only meaningful with a streaming `listener` (or `promptStream()`'s `lines`) — declares the expected shape of EACH line as the response streams in. See [Parsing lines with `lineSchema`](#parsing-lines-with-lineschema) below. The model is **not** forced to comply the way `schema` forces the final response — mention the expected format in `instructions` yourself. |
| `signal` | `AbortSignal` | Abort this call early — works for both `prompt()`'s unary and streaming paths (`promptStream()` too). Aborting cancels the underlying gRPC call for real, which the host observes and uses to stop `AIEngine.prompt()`'s own generation server-side — not just "the client stops listening" while the model keeps running/being billed regardless. `const c = new AbortController(); setTimeout(() => c.abort(), 5000); await ai.prompt(quest, { signal: c.signal });`. Local-only — never sent over the wire. Not yet wired for `getEmbedding`/`getEmbeddings` despite sharing this options type. Only reaches a call still in scope in the SAME invocation — use `request_id` + `ai.cancel()` below to cancel from somewhere else entirely. |
| `request_id` | `string` | Your own id for this call, set it if you might need to cancel it from a DIFFERENT invocation/process later via `ai.cancel(id)` — see [Cancelling from elsewhere](#cancelling-from-elsewhere-with-request_id) below. Omit if `signal` alone (same-invocation cancel) is enough. Sent to the host as `unique_request_id` (the backend's pre-existing tracking/audit field) — renamed here for a shorter public name; see the type's own doc comment for why. |

`MessageListener` (from `src/types/SDKTypes.ts`) — one of the two shapes `prompt()`'s 3rd parameter
accepts (the other being a plain `Writable` - see below), same interface as the backend's own
`AIEngine.prompt(quest, opts, listener)`:

| Field | Type | Wired? |
| --- | --- | --- |
| `onUpdate` | `(chunk: string, type?: string) => void` | ✅ Text deltas as they're generated. `type` is always `'text'` today. |
| `onReasoning` | `(reasoning: string) => void` | ✅ Reasoning-model "thinking" text, a separate stream from `onUpdate` — never fires for a model/request with no reasoning output. |
| `onLine` | `(line: string) => void` | ✅ Raw per-line text (`'\n'`-delimited) — does **not** need `lineSchema` set. |
| `onParsedLine` | `(parsed: ParsedLine \| null, index: number) => void` | ✅ Only fires when `opts.lineSchema` is set. `parsed` is `null` for a line that matched nothing in `lineSchema`. |
| `onCompleted` | `() => void` | ✅ Fires once, when the stream ends successfully. |
| `onError` | `(err: any) => void` | ✅ Fires once instead of `onCompleted`, if the call fails. |
| `onCreated` / `onResponse` / `interuptMessage` | — | ❌ Accepted for interface parity with the backend's real `MessageListener`, but never called over the SDK boundary — these map to the platform's own chat-message persistence lifecycle (`agent.reply`/session flows), which a raw `ai.prompt()` call has no equivalent of. |

A callback you throw inside is caught and logged (`console.error`), not left to silently break the
rest of the stream — the next chunk/line still arrives.

`ParsedLine` — one line already matched against `lineSchema`:

| Field | Type | Notes |
| --- | --- | --- |
| `form` | `string` | The matched keyword (multi-form `lineSchema`), `'json'` (JSON-line form), or `''` (single-template `lineSchema` — no keyword to report). |
| `fields` | `Record<string, any>` | Same value types as `schema`'s DSL — plus plain `string` (raw regex capture) when the line matched a bracket `LineTemplate` row instead of the JSON-line form. |

## `prompt` example

```typescript
import { ai } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const summary = await ai.prompt(`Summarize this ticket:\n${input.text}`, {
    instructions: 'Reply in 2 sentences, plain English, no markdown.',
    tier: 'light', // let the host pick a live model in this tier - avoid pinning `model` unless you need to
    temperature: 0.2,
  });
  return { status: 'success', data: summary };
}
```

### Instruction fields: `instructions` vs `base_instruction` vs `dynamic_instruction` vs `format_instruction`

Four separate fields feed the system prompt, not just `instructions` — the host assembles them (plus
`schema`'s auto-generated format text, `role`, `rules`, `style`) in a fixed order. Verified against
the backend's real behavior:

1. **`base_instruction`** — most-static platform/system-level rules. This is normally where the
   platform's own baseline system prompt already lives; a plugin call rarely needs to set it.
2. **`format_instruction`** — general output-format requirement text (e.g. "respond in valid JSON").
   Setting this **skips** the host's own auto-generated format text entirely (from `schema` or
   `response_format`) — leave it unset unless you need to say something the auto-generated text
   doesn't cover, since `schema` alone already produces an accurate one.
3. `schema`'s own auto-generated format text (only inserted as a text fallback for providers/tiers
   that don't reliably honor structured-output mode server-side — see [Structured output with
   `schema`](#structured-output-with-schema) below).
4. **`instructions`** — task-specific persona/role/instruction text. This is the field almost every
   caller wants; the examples throughout this doc use it.
5. `role` (a separate, plain-string `LLMPromptOptions` field — "Embody the persona of: `{role}`").
6. `rules`, then `style`.

`base_instruction`/`format_instruction`/`instructions`/`role`/`rules`/`style` all join into one
**"stable"** block — byte-identical across repeated calls in the same workflow/agent, so a driver
with explicit prompt-caching (Anthropic `cache_control`) can mark just that block cacheable.
**`dynamic_instruction`** is kept as a separate, non-cacheable block instead, specifically for
RAG/context/history content that changes every turn — joining it into the stable block would
invalidate the cache for everything else alongside it on every single call. Providers with automatic
prefix caching (OpenAI, Gemini) don't need this split and just get both blocks joined anyway, so
setting `dynamic_instruction` there is harmless, just pointless.

In short: reach for `instructions` by default, add `dynamic_instruction` when you're injecting
per-turn RAG/context content and might run on an Anthropic model, and leave `base_instruction`/
`format_instruction` alone unless you have a specific reason to override the platform's own
baseline/format text.

### Structured output with `schema`

`schema` is **not** a raw JSON Schema object — it's the platform's own Custom Schema DSL: a plain
object where each leaf value is a `"type - description"` string. The host converts this into the
real JSON Schema sent to the model, and separately re-validates the model's response against the
same DSL after the call, giving the model one self-heal retry on a field that comes back the wrong
shape. Verified against the backend's real behavior.

```typescript
import { ai } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const result = await ai.prompt(`Extract fields from: ${input.text}`, {
    schema: {
      title: 'string - Short ticket title',
      assignee: 'string? - Only if an assignee is explicitly mentioned',
      priority: 'enum - Ticket priority. enum: low, medium, high. default: medium',
      metadata: {
        source: 'string - Where this ticket came from',
        tags: ['string - One tag per label mentioned in the text'],
      },
    },
  });
  return { status: 'success', data: result };
}
```

**Syntax: `key: "type - description"`**

- `description` (after ` - `) is never enforced structurally, but it's what actually goes into the
  JSON Schema sent to the model and what `SchemaValidationHelper` echoes back in a self-heal retry
  — write it like you're briefing the model, not documenting for a human reader.
- **Optional fields** — append `?` to the *type*, not the key: `assignee: 'string? - ...'`. This is
  the only form the JSON Schema builder that talks to the model actually understands
  (`DriverHelper.parseTypeDescription` turns it into a `[type, 'null']` union) — a required field
  with no value fails validation and triggers self-heal, an optional one is simply skipped when empty.
  A trailing `?` on the *key* instead (`'assignee?': ...`) is a DIFFERENT, narrower convention: only
  `SchemaValidationHelper.validateSchema` (the same post-response self-heal check, plus the unrelated
  `PluginDataHelper.validate` used for validating mapped plugin data) strips it — the JSON-Schema
  builder (`DriverHelper.convertCustomSchemaToJSONSchema`) does **not** strip a key's `?`, so it would
  leak into `properties`/`required` as a literal `"assignee?"` field name the model has to match. Stick
  to `type?` for `schema`.
- **Enum** — `"enum - description. enum: val1, val2. default: val1"`. Options are split on
  `,`/`|`/`/`; the `default:` segment is a hint only (rendered into the JSON Schema's `default`,
  never silently substituted for a missing value at runtime).
- **Nesting** (multi-level, arbitrarily deep) — a value can itself be:
  - a nested object (recurses, same DSL) — `metadata: { source: 'string - ...', version: 'float - ...' }`
  - a single-element array for a list — `tags: ['string - one tag per label']`, or
    `steps: [{ id: 'string - ...', label: 'string - ...' }]` for a list of objects. Arrays of arrays
    work the same way (nest another `[...]` as the one element).
- **Supported types** — two tiers:
  - Shape the model actually sees in its JSON Schema (`DriverHelper.parseTypeDescription`):
    `string`, `number` / `float` / `double`, `int` / `integer`, `boolean` / `bool`, `object`, `array`,
    `enum` (rendered as a `string` with an `enum` constraint), `any` (rendered as a type-union of
    object/array/string/number/boolean — deliberately never collapsed to plain `string`, so the model
    can emit nested JSON directly instead of double-escaping it into a string).
  - Extra formats validated only at the runtime/self-heal layer, not reflected in the model-facing
    schema shape (the model just sees `string`; the format lives in your `description`):
    `email`, `phone`, `url`, `password`, `id`, `uuid`, `date`, `datetime`, `file`, `json`. Any other
    bare word (`agent`, `project`, `member`, ...) is treated as an "entity" type — accepted as valid
    whenever a value is present; the SDK boundary has no workspace context to check real existence,
    so treat these as semantic hints to the model, not real validation.

This exact same DSL is reused by `lineSchema` for its JSON-line form (a `Record<string, string>`
with no `[field:type - desc]` bracket syntax in its values) — see below.

### Choosing a tier

Set `opts.tier` instead of `opts.model` for normal use — `tier` asks the host for a *class* of model
and lets it resolve a live one, with real fallback; `model` pins one exact model with none of that
(see the `model` row in the options table above for when pinning is actually the right call).
Verified against the backend's real tier-resolution and fallback-cascade behavior.

| Tier | What it's for |
| --- | --- |
| `xhard` | Heaviest reasoning-capable models — hardest/most complex tasks. |
| `hard` | Reasoning-capable, one notch down from `xhard`. |
| `medium` | Reasoning-capable, the cheapest of the three reasoning tiers — also the universal fallback floor every other tier's cascade eventually lands on. |
| `light` | Fast/cheap, reasoning **disabled by default**. The platform default when you omit `tier` and `model` both. |
| `nano` | Cheapest/fastest, reasoning disabled by default — also where an org gets auto-downgraded to when it's out of credit/balance. |
| `code` | Code-specialized models (filtered by a `code` capability tag), not a cost tier like the others. |
| `vl` | Vision-capable models, for image-bearing input. |

**Resolution, in order:**

1. Neither `tier` nor `model` set → the host uses `model`/`provider` from env defaults and treats the
   call as `tier: 'light'`.
2. `tier` set, `model` not → the host resolves the *live* (provider, model) pair configured for that
   tier (`config/llm_tier.json`, admin-tunable at runtime, no redeploy needed), filtered to models
   currently online. `xhard`/`hard`/`medium` additionally filter to models tagged with a `reasoning`
   capability; `code` filters to models tagged `code`.
3. If every candidate in the requested tier is offline, it cascades to a fixed neighboring tier
   instead of failing outright:
   `xhard → hard → medium`, `hard → medium`, `light → medium`, `nano → light → medium`,
   `code → hard → medium`, `vl → medium` (`medium` itself has nowhere further to fall).
4. If the *requested* tier is down but a neighboring, pricier tier is up, the host silently upgrades
   to it instead of failing the call — the org gets billed at that tier's rate, and the caller-side
   user sees a one-time (throttled) cost-notice toast.
5. If the org is out of credit/wallet balance, the host force-downgrades to `nano` regardless of what
   was requested (again with a throttled toast, this time explaining the downgrade rather than a cost
   bump).
6. `model` set (and not `'auto'`) → skips ALL of the above. That exact model is used, or the call
   fails if it's offline — no cascade, no auto-upgrade, no downgrade.

`quality` (0-5, caps eligible models by price within whichever tier gets used) and `priority`
(`'high' | 'normal' | 'low'`, queuing order under load — never changes which model is picked) both
layer on top of `tier` the same way regardless of which step above actually resolved it.

### Streaming and piping with `prompt()`'s 3rd param

Pass a `MessageListener` (3rd parameter) and `prompt()` switches to the streaming RPC internally,
dispatching callbacks as data arrives:

```typescript
import { ai, call } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  let summary = '';
  await ai.prompt(`Write a short summary of: ${input.text}`, undefined, {
    onUpdate: async (delta) => {
      summary += delta;
      // e.g. forward progress to the user via realtime.publish as it's generated
      await call('realtime.publish', { event: 'summary.progress', data: delta });
    },
  });
  return { status: 'success', data: summary };
}
```

Pass a `Writable` instead (anything with `.write()`/`.end()` — a Node stream, a `PassThrough`, an
HTTP response) and `prompt()` writes text deltas straight into it, no manual bridging:

```typescript
import { ai } from '@aivin-labs/sdk';
import { PassThrough } from 'stream';

export async function main(mission, input, ctx) {
  const out = new PassThrough();
  // return/pipe `out` to whatever already consumes a stream (an HTTP response, another
  // Writable, `Readable.from`-based tooling...) while `prompt()` fills it concurrently
  const done = ai.prompt(`Write a short summary of: ${input.text}`, undefined, out);
  out.pipe(process.stdout); // or res, or any other Writable downstream
  await done;
  return { status: 'success' };
}
```

Either form resolves to the same final aggregated value a plain `ai.prompt(quest, opts)` call would
have — callers that only want the finished result never need to touch the 3rd param at all. Falls
back to a single "chunk" (the whole response, then done) if the model/provider resolved server-side
doesn't support token-level streaming; behaves the same either way, just with coarser granularity.
No automatic retry on transport failure mid-stream (unlike every other call in this SDK) — see
[CHANGELOG](../CHANGELOG.md) for why.

Prefer `promptStream()` instead if you want to `for await` the result yourself, or need an
`AsyncIterable` to compose with other pull-based tooling — see its own section below.

### Parsing lines with `lineSchema`

Set `opts.lineSchema` and `listener.onParsedLine` fires per-line, already parsed, as the response
streams in — no buffering `onUpdate` deltas and cutting on `'\n'` yourself.

No new syntax to learn here — every value you write inside `lineSchema` is one of exactly two things
already covered above:

- a bracket `[field:type - desc]` template — the line gets **regex-matched** against it positionally
  (`ParsedLine.fields` comes back all-string), or
- the same `"type - description"` DSL `schema` uses — the line gets **`JSON.parse`d** instead and
  checked against those field names (`ParsedLine.fields` comes back as real JSON types).

`lineSchema` itself is either a single string (one shape for the whole stream, no leading keyword) or
a `Record<string, string>` keyed by leading keyword (multiple shapes, tried in declaration order) —
which kind of value each key holds is auto-detected from whether it contains bracket syntax, not a
separate flag you set.

```typescript
import { ai } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const nodes: { id: string }[] = [];
  const edges: { from: string; to: string }[] = [];

  await ai.prompt(
    `List the steps of: ${input.process}, as NODE/EDGE lines`,
    {
      instructions:
        'One line per item. Format: `NODE [id:string - short id]` or ' +
        '`EDGE [from:string - source id] -> [to:string - target id]`.',
      lineSchema: {
        NODE: '[id:string - short id]',
        EDGE: '[from:string - source id] -> [to:string - target id]',
      },
    },
    {
      onParsedLine: (line) => {
        if (line?.form === 'NODE') nodes.push({ id: line.fields.id });
        if (line?.form === 'EDGE') edges.push({ from: line.fields.from, to: line.fields.to });
      },
    },
  );

  return { status: 'success', data: { nodes, edges } };
}
```

When there's only one line shape, pass a plain `LineTemplate` string instead of a keyword map — every
line is matched against it directly, no leading keyword needed (`line.form` comes back as `''`):

```typescript
import { ai } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const steps: { from: string; to: string }[] = [];

  await ai.prompt(
    `List the steps of: ${input.process}, as one edge per line`,
    {
      instructions: 'One line per edge. Format: `[from:string - source id] -> [to:string - target id]`.',
      lineSchema: '[from:string - source id] -> [to:string - target id]',
    },
    {
      onParsedLine: (line) => {
        if (line) steps.push({ from: line.fields.from, to: line.fields.to });
      },
    },
  );

  return { status: 'success', data: { steps } };
}
```

Or drop the brackets entirely and use `schema`'s own `"type - description"` DSL — each line gets
`JSON.parse`d instead of regex-matched, and `line.form` comes back `'json'`:

```typescript
import { ai } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const tasks: { title: string; done: boolean }[] = [];

  await ai.prompt(
    `List the tasks in: ${input.text}`,
    {
      instructions:
        'One JSON object per line, no markdown, no surrounding array: ' +
        '{"title": "...", "done": true|false}.',
      lineSchema: {
        title: 'string - Task title',
        done: 'boolean - Whether it is already marked done',
      },
    },
    {
      onParsedLine: (line) => {
        if (line?.form === 'json') tasks.push({ title: line.fields.title, done: line.fields.done });
      },
    },
  );

  return { status: 'success', data: { tasks } };
}
```

A line that doesn't match anything in `lineSchema` still fires `onParsedLine` with `parsed: null` —
read `onLine` (raw) alongside it if you
need the unmatched line's original text.

### `promptStream` — pull-based (`AsyncIterable`) streaming

Same streaming transport as above, wrapped in an `AsyncIterable`-returning shape instead of a
`prompt()` 3rd param. Reach for this when you want to `for await` the result yourself or compose it
with other iterable-based tooling (`Readable.from(result.textStream)`, async generator pipelines) —
`prompt(quest, opts, aWritable)` covers the push-into-an-existing-stream case instead:

```typescript
import { ai, call } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const result = ai.promptStream(`Write a short summary of: ${input.text}`);

  for await (const delta of result.textStream) {
    await call('realtime.publish', { event: 'summary.progress', data: delta });
  }

  const summary = await result.text; // full text, resolves once the stream ends
  return { status: 'success', data: summary };
}
```

`text`/`lines` resolve correctly even if you never iterate `textStream`/`lines` — the stream drains
from the network as soon as `promptStream()` is called, independent of whether/how fast you consume
it.

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

## Cancelling from elsewhere with `request_id`

`opts.signal` (above) only works while the caller still holds the `AbortController` in scope - fine
for "user closed this same request", not for "a separate 'Stop' button/webhook needs to cancel a
call some other invocation started". For that, give the call an id and cancel it by id later, from
anywhere:

```typescript
import { ai } from '@aivin-labs/sdk';
import { randomUUID } from 'crypto';

// Invocation A - starts a long-running generation, remembers the id somewhere (a DB row, a job
// record, ...) so a later, unrelated invocation can find it.
export async function main(mission, input, ctx) {
  const id = randomUUID();
  await saveRunningRequestId(input.job_id, id); // your own bookkeeping
  return ai.prompt(input.prompt, { request_id: id }, { onUpdate: (d) => publish(d) });
}

// Invocation B - a completely separate request (e.g. a "Stop" webhook), no reference to
// invocation A's AbortController at all - just the id.
export async function stopHandler(mission, input, ctx) {
  const id = await loadRunningRequestId(input.job_id);
  await ai.cancel(id);
  return { status: 'success' };
}
```

Cancellation is broadcast to every backend node and takes effect immediately wherever the request
actually is (not a polled flag with some seconds of lag) - same pubsub pattern used elsewhere on
the backend for background jobs. `cancelled_locally` in the return value only reflects whether THIS
specific backend node happened to have it running - `false` does not mean the cancel failed, just
that it had to reach a different node.

## Generating images and video with ocr, image, video

`ai.ocr`/`ai.image`/`ai.video` were implemented on the backend long before they were wired into this
SDK - they're real, reachable RPCs, not new functionality:

```typescript
import { ai } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  // OCR - image needs a real `url` or `file` (base64 dataURL/Buffer); `id` is caller-chosen
  const text = await ai.ocr({ id: 'scan-1', url: input.image_url });

  // Image generation - max_cost_usd is the one option worth setting: over-estimate auto-downgrades
  // to a cheaper tier (or throws if none fits) instead of silently costing more than expected
  const image = await ai.image(`A diagram illustrating: ${text}`, { max_cost_usd: 0.05 });

  return { status: 'success', data: { text, image_url: image.url } };
}
```

`image`/`video` take `MediaPromptOptions` (a superset of `LLMPromptOptions`) - **not** the LLM `tier`
from [Choosing a tier](#choosing-a-tier) above, a **separate** `media_tier` scoped to image/video
routing instead (`quality`/`balanced`/`fast`/`budget`/`text`/`vector`/`creative`/`cinematic` for
images; `quality`/`balanced`/`fast`/`budget`/`motion`/`cinematic`/`creative`/`character` for video),
plus `media_preference` (`'quality' | 'price' | 'balanced'` - which model to prefer within that
tier) and `max_cost_usd` above. They resolve to a `MediaGenerationResult`: exactly one of `url`/`data`
is populated (storage upload vs. inline base64), plus `mimeType`/`width`/`height`/`provider`/`model`.
`video` is slower and more expensive than `image` - always set `max_cost_usd` unless cost is a
non-concern for that call site. Verified against the backend's real behavior.

## Notes & caveats

- Param shapes here are verified against the backend's real implementation, **not**
  just its declared type contract — the declared type file diverges from the real implementation in at least two
  places: it declares `getEmbeddings({texts, opts})` (object-wrapped) when the real code takes
  `getEmbeddings(texts, opts)` (bare array first arg), and it declares `rerank(query, docs, ...opts)`
  (spread) when the real code nests rerank options under a single `opts` object.
- `tts`/`stt`/`getModels`/`calculateTokens` are confirmed against the backend's real registration
  — exact return shapes are otherwise untyped (`Promise<any>`).
- `rerank`'s `opts` is accepted client-side but **dropped server-side** (see the method table) — do
  not rely on any field in it; post-process the returned `{index, score}` list yourself instead.
- `prompt()`'s streaming path (`driver` given) properly backpressures end-to-end: a slow
  `onUpdate`/`onLine`/`onParsedLine`/`onReasoning` handler genuinely slows the model generation down
  (via gRPC `'drain'` all the way back to the provider's own SSE read loop), instead of letting
  chunks pile up in an unbounded buffer somewhere in between. Any handler may return a `Promise` to
  participate in this - `prompt()` awaits it before pulling the next chunk/line (see
  `MessageListener`'s doc comment above).
- Piping into a `Writable` respects ITS backpressure too, the same contract `readable.pipe(writable)`
  itself honors: `prompt()` checks `.write()`'s return value and waits for `'drain'` before writing
  the next chunk, so a downstream consumer slower than the model (a throttled HTTP response, a slow
  disk write) never has its own internal buffer grow unbounded.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
