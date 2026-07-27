# 🤖 `agent` — inspect and delegate to AI Staff agents

The `agent` namespace looks up an AI Staff agent's profile, checks its current run status, cancels
an in-flight response, and delegates work to another agent (by ID or free-text search) and awaits
its result. It does **not** cover asking the human user a question or human-in-the-loop review —
those live as top-level `ask()`/`hil()` functions, not on this namespace (see Notes below).

## Import

```typescript
import { agent } from '@aivin/sdk';
// equally: ctx.sdk.agent / import SDK from '@aivin/sdk'; SDK.agent
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `get` | `id?: string` | `Promise<Agent>` | Get an AI Staff agent's profile. Defaults to the current agent when `id` is omitted. |
| `status` | `id?: string` | `Promise<any>` | Current run status for an agent. |
| `cancel` | `sessionId: string, threadId?: string` | `Promise<any>` | Cancel an in-flight agent response. |
| `delegate` | `target: string, data: Record<string, unknown>, purpose: string` | `Promise<any>` | Hand off work to another agent and await its result. Identical to top-level `a2a(target, data, purpose)`. |

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
import { agent } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  const me = await agent.get(); // defaults to the current agent
  const other = await agent.get('agent-id-123');
  return { status: 'success', data: { me, other } };
}
```

## `status` / `cancel` example

```typescript
import { agent } from '@aivin/sdk';

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
import { agent } from '@aivin/sdk';

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
  user's public profile (`ctx.sdk.user(id)` / `import { user } from '@aivin/sdk'`), unrelated to
  agent delegation.
- `ask()` and `hil()` block the current plugin run waiting on a human response (or time out) — they
  are for human-in-the-loop workflows, distinct from `agent.delegate`'s agent-to-agent handoff:
  - `ask(question: string, schema?: Record<string, any>): Promise<string | null>`
  - `hil(key: string, prompt: string, options?: { selections?: Array<{ label: string; value: string; description?: string }>; allow_custom_input?: boolean; custom_input_placeholder?: string; timeout_ms?: number }): Promise<{ value: string; label?: string; is_custom: boolean }>`

## See also

- [SDK Reference](../SDK.md) — the full `ctx.sdk` surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
