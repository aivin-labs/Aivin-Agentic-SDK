# 🤖 `agent` — inspect and delegate to AI Staff agents

The `agent` namespace looks up an AI Staff agent's profile, checks its current run status, cancels
an in-flight response, and delegates work to another agent (by ID or free-text search) and awaits
its result. It does **not** cover asking the human user a question or human-in-the-loop review —
those live as top-level `ask()`/`hil()` functions, not on this namespace (see Notes below).

## Import

```typescript
import { agent } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.agent
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `get` | `id?: string` | `Promise<Agent>` | Get an AI Staff agent's profile. Defaults to the current agent when `id` is omitted. |
| `status` | `id?: string` | `Promise<any>` | Current run status for an agent. |
| `cancel` | `sessionId: string, threadId?: string` | `Promise<any>` | Cancel an in-flight agent response. |
| `delegate` | `target: string, data: Record<string, unknown>, purpose: string` | `Promise<any>` | Hand off work to another agent and await its result. Identical to top-level `a2a(target, data, purpose)`. |
| `reply` | `quest: string \| any[], opts?: AgentReplyOptions` | `Promise<any>` | Prompt the LLM and **stream the result into the current chat bubble** as a real, persisted message — same call shape as `ai.prompt`, but tied to this invocation's chat session instead of returning a bare string with no UI side effect. `opts.rich_content: true` unlocks passive rich components (table/chart/mermaid/media/cardview/webview) — see [Rich components and HIL](#rich-components-and-hil) below. |
| `tell` | `text: string` | `Promise<{ success: boolean }>` | Push text **you already have** into the chat bubble with a typing animation, persisted like any other message — **no LLM call**. `success: false` (not a throw) when there's no live chat session to stream into. |
| `processMessage` | `message: Record<string, any>, storageContext?: Record<string, any>` | `Promise<any>` | Runs a full message-processing pass through the agent (NLU → agentic/action/assistant routing) as if `message` had arrived on the invoking user's session. Identity is always taken from `ctx.user`, never `message`. |
| `resolveHil` | `params: { session_id: string; reply_id: string; payload?: any }` | `Promise<{ success: boolean; reply_id: string; error?: string }>` | Resolves a PAUSED human-in-the-loop checkpoint (e.g. a visitor's selection/form reply arriving over a transport other than the SDK's own `agent.hil()` wait) to resume the paused workflow. |

`Agent` shape (from `SDKTypes.ts`):

```typescript
interface Agent {
  id: string;
  name: string;
  avatar?: string;
  role?: string;
  description?: string;
  status: 'active' | 'inactive';
}
```

## `get` example

```typescript
import { agent } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const me = await agent.get(); // defaults to the current agent
  const other = await agent.get('agent-id-123');
  return { status: 'success', data: { me, other } };
}
```

## `status` / `cancel` example

```typescript
import { agent } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const status = await agent.status('agent-id-123');
  if (status?.state === 'stuck') {
    await agent.cancel(input.sessionId, input.threadId);
  }
  return { status: 'success', data: status };
}
```

## `delegate` example

```typescript
import { agent } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  // target can be a real agent ID, or a free-text description — if `target` doesn't look like
  // an ID (contains a space, is longer than 32 chars, or has non-hex characters), it's resolved
  // via workspace.searchAgents first and the top match is used.
  const result = await agent.delegate(
    'billing specialist',
    { invoiceId: input.invoiceId },
    'Please reconcile this invoice against the payment ledger',
  );
  return { status: 'success', data: result };
}
```

`agent.delegate(target, data, purpose)` is exactly `a2a(target, data, purpose)` under the hood —
use whichever reads better at the call site; there is no behavioral difference.

## `reply` example

```typescript
import { agent } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  // One line: the user sees this typed into the chat as it's generated, exactly like a normal
  // agent response — no realtime.publish plumbing, no manual buffering.
  const text = await agent.reply(`Summarize this ticket for the user:\n${input.text}`, {
    instructions: 'Reply in 2 sentences, plain English.',
  });

  return { status: 'success', data: { replied: text } };
}
```

### Why not just `ai.prompt`?

`ai.prompt`/`ai.promptStream` are pure LLM calls — they return text to *your code*, nothing more.
Historically, streaming that text into the user's chat as it generates required either:

- the (Docker-runtime-only) `realtime.publish` side channel, which is fire-and-forget, not
  persisted, and not rendered as a chat message by default (the frontend has to know to listen for
  your specific event name and do something with it), or
- for in-process/official plugins only, manually wiring `AIEngine.prompt(quest, opts, driver)` with
  a `{ ctx, listener }` driver built from the host's internal `MessageService` — not reachable from
  plugin code at all (`AIEngine` isn't part of the SDK surface), so in practice nobody could do this
  outside the platform's own agent orchestration code.

`agent.reply` is that exact internal mechanism (the same one `AgentService` uses for its own
feedback messages), exposed as a one-line SDK call. It's on `agent`, not `ai`, because it's
inherently about *this invocation's chat session* (creates a real, persisted message, buffered/
flushed the same way the platform's own replies are) — not a generic model-inference primitive.

- If there's no live chat session in this invocation's context (e.g. running from automation, a
  webhook, or a raw API trigger with no attached user/session), `agent.reply` silently falls back to
  a plain, non-streamed `ai.prompt` call — same return value either way, just nothing gets streamed
  anywhere. Safe to call unconditionally without checking the channel yourself.
- Calling `agent.reply` twice in one invocation produces two separate chat messages — there's no
  hidden batching across calls, only within a single call's own token stream.
- If you need the LLM output *inside your own code* (to parse, branch on, forward elsewhere) instead
  of showing it to the user, use `ai.prompt`/`ai.promptStream` instead — `agent.reply`'s return value
  is the same final text, but the whole point of reaching for it is the chat side effect.
- **Rate limited per chat session** (shared with `agent.tell`, same bucket): by default 20 pushes
  per 60s per session — throws if exceeded rather than silently dropping. This exists because
  neither call has a cost gate that would naturally stop a buggy/looping plugin from flooding a
  user's chat; server ops can retune the limit via the `sandbox.agent_chat_push_rate_limit` config
  (`{ limit, window_sec }`) without a redeploy.

## `tell` example

```typescript
import { agent } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  // Text composed locally / fetched from somewhere else — not generated by an LLM call here.
  const summary = buildSummaryFromRows(input.rows);

  const { success } = await agent.tell(summary);
  if (!success) {
    // No live chat session (e.g. this ran from automation) — text was never shown anywhere.
  }

  return { status: 'success', data: { summary } };
}
```

`tell` is `reply`'s sibling for when you already have the final text and just want it to *appear* as
a chat turn — no model call, no token cost, no `LLMPromptOptions`. Internally it reuses the same
word-by-word "simulated typing" animation the platform uses for things like error messages, so the
UX matches a normal streamed reply even though nothing is actually streaming from a model.

- Like `agent.reply`, calling it more than once in a single invocation produces separate chat
  messages — there's no batching across calls.
- There's no async-iterable/live-chunk variant (`agent.tellStream`) yet — `tell` takes a complete
  string. If you're relaying chunks you're generating in real time yourself (not via
  `ai.promptStream`, which `agent.reply` already covers end-to-end), that would need a
  client-to-host streaming RPC this SDK doesn't have today; open an issue if you hit this.
- Shares the same per-session rate limit bucket as `agent.reply` (20 pushes / 60s by default) —
  see `reply`'s notes above. Since `tell` has no LLM cost to act as a natural throttle, this is the
  *only* thing stopping a loop from flooding a chat with unlimited persisted messages.

## Rich components and HIL

The chat UI can render more than plain text — tables, charts, mermaid diagrams, media embeds,
card views, and (separately) **interactive** components like selection buttons and forms. These
aren't a structured payload you attach to a message; they're specific fenced-block markup
(similar in spirit to the ` ```table ` blocks in [MANIFEST.md](../MANIFEST.md)) that the
**model itself generates** inside its response text, and the frontend parses out and renders.

This has a direct, important consequence for `reply` and `tell`:

- **`agent.reply` with `opts.rich_content: true`** teaches the model this markup for *passive*
  components only (table, chart, mermaid, media, cardview, webview, citation) — the same mechanism
  (`InstructionBuilder`) the platform's own agent uses for its normal replies. Without this flag,
  the model has no idea it's allowed to emit that syntax, even if you ask it to nicely in
  `opts.instructions` — plain instruction text does not unlock it.
- **`agent.reply` never unlocks selection/form/action** (the interactive components), regardless of
  `rich_content`. **`agent.tell` never unlocks anything** — it's raw text passthrough, whatever
  string you give it is exactly what gets shown.

### Why interactive components need `agent.hil()`, not `reply`/`tell`

A selection/form/action component isn't just markup — clicking it needs to route a response
*back* to whichever piece of code asked the question. That routing only exists because
`agent.hil()` sets up real infrastructure before rendering anything: it acquires a lock on the
chat thread, and (in agentic/automation flows) suspends the workflow via a signal that's resumed
only when a matching reply arrives. `reply` and `tell` do none of this.

Concretely: if you prompt `agent.reply` to "ask the user to pick A or B" with `rich_content: true`
(or worse, hand-write a selection block's markup into `agent.tell`'s `text`), you can absolutely get
something that *looks* like a working button in the chat UI. Clicking it will not resume your
plugin, will not be routed anywhere your code can see, and may just be silently dropped or treated
as an unrelated chat message. This fails quietly — no error, no timeout, just a dead button — which
is exactly what makes it dangerous to reach for by habit.

**Rule of thumb:** if the user needs to respond to what you're showing them, use `agent.hil()` (or
the simpler top-level `ask()`). Reach for `reply`/`tell` only for one-way output — an answer, a
progress narration, a formatted report — that nobody needs to click on.

## Notes & caveats

- **`agent.ask`/`agent.hil` do not exist** on the real backend's `get agent()` (`src/base/SDK.ts`).
  Only the standalone top-level `ask(question, schema?)` and `hil(key, prompt, options?)` functions
  are real — call those directly instead of looking for a namespaced variant.
- `agent.delegate` itself isn't defined on the real backend's `get agent()` either — only the
  standalone `a2a()` is. This SDK adds `agent.delegate` purely as a convenience alias that reuses
  `a2a()`'s search-resolution logic, for API consistency with the rest of the `agent` namespace.
  The underlying `agent.delegate` RPC namespace it calls through is confirmed real.
- `a2a()`'s target-resolution heuristic (also used by `agent.delegate`): a string is treated as a
  literal agent ID only if it has no spaces, is 32 characters or fewer, and matches
  `/^[0-9a-fA-F-]+$/`. Anything else is treated as a search query and resolved via
  `workspace.searchAgents({ query: target, limit: 1 })` — throwing `No agent found matching: <target>`
  if nothing matches.
- `user(id)` is a **separate top-level function**, not part of the `agent` namespace — it returns a
  user's public profile (`import { user } from '@aivin-labs/sdk'`), unrelated to
  agent delegation.
- `ask()` and `hil()` block the current plugin run waiting on a human response (or time out) — they
  are for human-in-the-loop workflows, distinct from `agent.delegate`'s agent-to-agent handoff:
  - `ask(question: string, schema?: Record<string, any>): Promise<string | null>`
  - `hil(key: string, prompt: string, options?: { selections?: Array<{ label: string; value: string; description?: string }>; allow_custom_input?: boolean; custom_input_placeholder?: string; timeout_ms?: number }): Promise<{ value: string; label?: string; is_custom: boolean }>`

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
