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
| `runFlow` | `flow: WorkflowGraph \| FlowStage[], opts?: { flowName?: string; context?: RunFlowContext; onEvent?: (e: ClientLogEvent) => void }` | `Promise<FlowStepResult[]>` | Runs a flow (CONDITION/ROUTER/PARALLEL/RETRY/WAIT/LOOP/ACTION steps) directly, no NLU/planning step first — see [`runFlow`](#runflow) below. |
| `promptAgentic` | `prompt: string, opts?: { args?: Record<string, any>; context?: RunFlowContext; onEvent?: (e: ClientLogEvent) => void }` | `Promise<any>` | Forces the full multi-step planner (plan/audit/replan), skipping NLU mode classification — see [Forcing a mode](#forcing-a-mode-promptagentic--promptaction--promptassistant) below. |
| `promptAction` | `prompt: string, opts?: { context?: RunFlowContext; onEvent?: (e: ClientLogEvent) => void }` | `Promise<any>` | Forces single-plugin direct execution (no planning), skipping NLU mode classification. |
| `promptAssistant` | `prompt: string, opts?: { context?: RunFlowContext; onEvent?: (e: ClientLogEvent) => void }` | `Promise<any>` | Forces plain conversational (RAG, no tool use) mode, skipping NLU mode classification. |
| `prompt` | `prompt: string, opts?: { context?: RunFlowContext; onEvent?: (e: ClientLogEvent) => void }` | `Promise<any>` | Auto-routes through the same NLU classification `processMessage` uses (agentic/action/assistant) — the lightweight counterpart to `processMessage`, taking a plain string instead of a full message object. See [`prompt`](#prompt-lightweight-auto-routing) below. |

All five of `runFlow`/`promptAgentic`/`promptAction`/`promptAssistant`/`prompt` share the same
`opts.context` (`RunFlowContext`, built with `ContextBuilder`) and `opts.onEvent` (live progress
events) shape — see [`runFlow`](#runflow)'s `context` section and
[Realtime progress](#realtime-progress-onevent) below; both apply identically to all five.

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

## `runFlow`

Runs a flow — CONDITION/ROUTER/PARALLEL/RETRY/WAIT/LOOP/ACTION steps executed in order — directly
from code, with no LLM planning/NLU step deciding what to do first (unlike `agent.processMessage`,
which routes a message through agentic/action/assistant, or `automation.createJob`, which infers a
schedule and *may* run the `workflow` field through the full planner too). Same execution engine a
published `workflow`-type plugin runs on, and the same one `automation.createJob`'s `workflow` field
eventually drives — this is that engine called straight from your own code, skipping the "save this
as a plugin" or "schedule this as a job" step.

```typescript
import { agent, ContextBuilder } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  // `flow` here is a WorkflowGraph { nodes, edges } — exported/copied straight out of the
  // platform's Workflow Editor (WorkflowSkillEditor), no hand-conversion needed.
  const results = await agent.runFlow(input.flow, {
    flowName: 'Nightly reconciliation',
    context: ContextBuilder()
      .useAgent(input.agentId)
      .useSession(ctx.session?.id) // run inside THIS conversation instead of a new hidden one
      .useAttachments(input.attachments)
      .build(),
  });

  return { status: 'success', data: results };
}
```

### Input: `WorkflowGraph` vs `FlowStage[]`

`flow` accepts either shape — pick whichever matches how the flow was produced:

- **`WorkflowGraph`** (`{ nodes, edges }`) — the JSON the Workflow Editor exports/saves into a
  plugin manifest's `workflow_data`. This is the shape to reach for whenever the flow was designed
  visually and you just need to *run* it from code (a webhook handler, a scheduled check, a manual
  trigger) without publishing it as its own plugin first. The backend
  (`WorkflowPluginService.buildStages`) converts it into executable stages and throws a specific
  error naming the offending node if something's malformed — nothing is silently ignored.
- **`FlowStage[]`** — an already-built list of stages, for building/generating a flow programmatically
  (e.g. constructing steps from data rather than a canvas) instead of hand-authoring a node graph.
  Loosely typed on purpose (`{ id, type, ...rest }`) — the backend validates/guards per stage type at
  runtime; an unrecognized or misconfigured stage is skipped with a warning rather than crashing the
  whole flow.

### `context`: what identity the flow runs as

`agent.runFlow` does **not** automatically inherit the calling invocation's live conversation state
beyond a bare fallback (the current session's agent/workspace) — the sandbox boundary this call
crosses does not carry that state across. Anything the flow needs — which agent it runs as, which
session/thread to attach to, extra attachments — must be passed explicitly via `context`. Build one
with `ContextBuilder`:

```typescript
import { ContextBuilder } from '@aivin-labs/sdk';

const context = ContextBuilder()
  .useAgent(agentId)       // which AI Staff agent runs the flow
  .useWorkspace(wsId)      // defaults to the calling invocation's workspace if omitted
  .useSession(sessionId)   // reuse an existing session/thread instead of a new invisible one
  .useProject(projectId)
  .useAttachments(files)
  .build();
```

- Omitting `useAgent`/`useWorkspace` falls back to the calling invocation's own current
  agent/workspace — omit both entirely for "run as me, in my workspace."
- Omitting `useSession` runs the flow in a **new, separate session/thread** you won't see appear
  anywhere in the current chat (same as how a published `workflow`-type plugin runs today) — pass
  the current session's ID (e.g. `ctx.session?.id` from a chat-triggered invocation) to have the
  flow's steps show up as part of the ongoing conversation instead.
- A flow calling `agent.runFlow` on itself (directly, or through a chain of flows calling each
  other) is capped at depth 5 server-side — same guard the platform already applies to
  agent-to-agent delegation and workflow-plugin-calling-workflow-plugin chains.

`FlowStepResult` shape (one entry per executed stage):

```typescript
interface FlowStepResult {
  stepIndex: number;
  action_intent: string;
  mission: string;
  result: { status: string; message?: string; data?: any };
}
```

## Forcing a mode: `promptAgentic` / `promptAction` / `promptAssistant`

`agent.processMessage` runs a message through NLU classification first, which picks exactly one of
three modes before doing anything else:

- **agentic** — full multi-step planner (plan → execute → audit → replan)
- **action** — pick one plugin, run it, no planning
- **assistant** — plain conversational reply (RAG-backed), no tool use

`promptAgentic`/`promptAction`/`promptAssistant` call the backend's own implementation of each mode
**directly**, skipping that classification step entirely — for when the caller already knows which
mode this turn needs and doesn't want to pay for (or risk a wrong) NLU guess:

```typescript
import { agent, ContextBuilder } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  // This step of the plugin's own logic always wants a straight, tool-free answer — no reason to
  // let NLU re-decide that every run.
  const answer = await agent.promptAssistant(`Summarize the risk in plain terms: ${input.text}`, {
    context: ContextBuilder().useSession(ctx.session?.id).build(),
  });
  return { status: 'success', data: answer };
}
```

- Each mode **keeps its own internal fallback chain** — forcing the initial choice does not disable
  it. `promptAgentic` still falls back to assistant on failure; `promptAction` still falls back to
  assistant (no plugin matched) or agentic (plugin execution failed). Only the *first* decision is
  forced; error recovery behaves exactly as it does through `processMessage`.
- `opts.context` works exactly like `runFlow`'s — build with `ContextBuilder`, same fallback to the
  calling invocation's own agent/workspace when omitted, same `useSession(...)` to keep the reply
  inside the current conversation instead of a new hidden one.
- `promptAgentic`'s `opts.args` is passed straight through to the planner's own `args` parameter
  (rarely needed — most callers can omit it).
- Return shape is whatever that mode's own result looks like (not `FlowStepResult[]` like
  `runFlow`) — `promptAssistant`/`promptAgentic` resolve to a chat-message-shaped result,
  `promptAction` resolves to either that or the executed plugin's raw response, depending on the
  plugin's `feedbackable` flag. Treat the return value as `any` and read what you need from it.

## `prompt`: lightweight auto-routing

`agent.prompt` is the auto-routing counterpart of `promptAgentic`/`promptAction`/`promptAssistant` —
instead of forcing one mode, it runs `prompt` through the **exact same NLU classification**
`agent.processMessage` uses to pick agentic/action/assistant. The difference from `processMessage`
is purely ergonomic: `processMessage` requires building a full message object (`session_id`,
attachments, etc.) yourself because it's designed to receive a message that already arrived over a
real transport (chat, widget, webhook); `prompt` takes a plain string, resolves/creates the session
via `opts.context` the same way `runFlow`/`promptX` do, and calls `processMessage` under the hood —
same production pipeline (quota checks, human-takeover check, NLU classification, all three modes'
own fallback chains), just without the message-object boilerplate.

```typescript
import { agent } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  // Let the platform decide agentic vs action vs assistant for this turn.
  const result = await agent.prompt(input.text, {
    context: { session_id: ctx.session?.id },
  });
  return { status: 'success', data: result };
}
```

Use `prompt` when you don't know (or don't want to hardcode) which mode a given turn needs; use
`promptAgentic`/`promptAction`/`promptAssistant` when you already do — see
[Forcing a mode](#forcing-a-mode-promptagentic--promptaction--promptassistant) above for that
tradeoff in more detail.

## Realtime progress: `onEvent`

All five of `runFlow`/`promptAgentic`/`promptAction`/`promptAssistant`/`prompt` normally resolve
once — you get the final result and nothing else. Pass `opts.onEvent` to additionally receive every
progress log line **live, as it happens** — the same log lines the platform's own chat UI streams in
real time (`flow.step_progress`, `agent.using_tool`, `agent.tool_complete`, `flow.loop_iteration`,
...):

```typescript
import { agent } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const results = await agent.runFlow(input.flow, {
    onEvent: (event) => {
      console.log(`[${event.status}] ${event.message}`); // e.g. "[process] Step 2/5: Send email"
    },
  });
  return { status: 'success', data: results };
}
```

```typescript
interface ClientLogEvent {
  id: string;
  session_id: string;
  thread_id: string;
  channel: string;
  message: string;               // human-readable, already localized
  status: 'process' | 'success' | 'error' | 'debug';
  timestamp: number;
  event_key?: string;            // raw i18n key (e.g. "flow.step_progress") - branch on this, not `message`
  meta?: Record<string, any>;
}
```

- **Passing `onEvent` changes the call shape**: without it, the SDK makes a plain unary gRPC call
  (`Invoke`) exactly like any other namespace. With it, the SDK opens a **server-streaming** gRPC
  call (`InvokeStream` — the same RPC `ai.promptStream` uses) that stays open for the whole duration
  of the run. Only pass it when you actually intend to consume progress events; omitting it costs
  nothing extra.
- Events arrive in the order they're logged server-side, but delivery itself is best-effort — a
  transport hiccup can drop an event without failing the call; `onEvent` is for observability
  (progress narration, custom logging/telemetry), not a source of truth to branch business logic on.
  The awaited return value is always the complete, authoritative result regardless of which/how many
  events arrived.
- A malformed/non-JSON chunk is silently dropped rather than thrown — a broken observability
  side-channel must never break the actual call.
- These events are the same ones the platform streams to the chat UI via Socket.IO — `onEvent`
  doesn't replace or redirect that, it's an *additional* channel; both fire for the same underlying
  `clientLog(...)` calls happening server-side.
- If the SAME `context.session_id` is reused by two overlapping calls (e.g. a flow step itself calls
  `agent.promptAssistant` with `context.session_id` pointing back at the same session it's already
  running in, both with their own `onEvent`), each call only receives its own events — the backend
  keeps a separate sink per call, not one shared slot per session.

### `timeoutMs`

All five default to a **5-minute** client-side timeout, not the SDK's general 30s default — an
agentic plan or a flow with LOOP/WAIT stages routinely runs longer than a typical call. Pass
`opts.timeoutMs` to raise (or lower) it further for flows expected to take longer still:

```typescript
await agent.runFlow(input.flow, { timeoutMs: 15 * 60_000 }); // 15 minutes
```

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
