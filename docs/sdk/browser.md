# 🌐 `browser` — AI Browser missions

Triggers a full, multi-step, self-correcting AI Browser mission: the platform drives a real
browser session toward a goal described in natural language, adjusting its own steps as it
observes each page. This is **slower and heavier** than any other SDK call — it isn't a simple
request/response fetch, it's an autonomous agent loop that can take many actions (navigation,
clicks, form fills, scraping) before returning. Reach for it only when the task genuinely requires
interacting with a live website; for one-shot HTTP fetching or scraping, prefer a lighter-weight
approach if one is available to your plugin.

## Import

```typescript
import { browser } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.browser
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `run` | `mission: string, opts?: { start_url?: string; success_criteria?: string[]; steps?: string[]; output_schema?: Record<string, any>; [key: string]: any }` | `Promise<any>` | Calls `browser.run` with `{ mission, data: opts }`. Runs a full self-correcting AI Browser mission described by `mission`, optionally seeded with a starting URL, explicit success criteria, suggested steps, and/or a schema the final output should conform to. |
| `cancel` | `sessionId?: string` | `Promise<{ success: boolean; session_id: string }>` | Calls `browser.cancel` with `{ session_id: sessionId }` (or `{}` if omitted). Requests cancellation of a running mission — cooperative only, see caveats below. |

## `run` example

```typescript
import { browser } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const result = await browser.run(
    'Find the current listed price of the flagship laptop on this vendor site',
    {
      start_url: 'https://example-vendor.com/laptops',
      success_criteria: [
        'A specific price in USD has been found',
        'The product name matches "flagship laptop"',
      ],
      output_schema: {
        type: 'object',
        properties: {
          product_name: { type: 'string' },
          price_usd: { type: 'number' },
        },
        required: ['product_name', 'price_usd'],
      },
    },
  );

  return { status: 'success', data: result };
}
```

## `cancel` example

```typescript
import { browser } from '@aivin-labs/sdk';

// Cancel the mission currently running for your own tenant — no argument needed, this is
// the normal way to call it:
await browser.cancel();

// session_id is only useful as a self-check: it's rejected unless it equals your own tenant's
// session id. It is NOT a way to target or cancel another tenant's mission.
const started = await browser.run('Long-running research task', { start_url: '...' });
await browser.cancel(started.data.session_id); // same effect as browser.cancel() with no args
```

## Notes & caveats

- `browser.run()` is NOT a lightweight call — it drives a full multi-step, self-correcting agent
  session against a real browser. Expect materially higher latency (and cost) than any other
  namespace in this SDK; don't call it in a tight loop or as a substitute for a simple fetch.
- The return type is `any` in `SDKClient.ts` — there is no confirmed fixed shape for the mission
  result. If you pass `output_schema`, the result is expected to conform to it, but that's a
  request to the mission runner, not a client-side guarantee — validate the shape you get back
  before trusting it.
- The resolved (or rejected-as-failed/cancelled) result carries `data.session_id` — the backend's
  internal tenant client id for that mission. Save it if you might want to `cancel()` it later from
  a different call.
- `opts` carries an open `[key: string]: any` index signature in addition to the four named,
  documented fields (`start_url`, `success_criteria`, `steps`, `output_schema`) — any other keys
  you add are passed straight through to the backend without client-side validation.
- The call is built as `{ mission, data: opts }` — i.e. everything you pass as the second argument
  is nested under `data` in the actual RPC payload, not sent flat alongside `mission`.
- **HIL (human-in-the-loop) is not supported through `browser.run()`.** It calls straight into the
  backend's `AIBrowserService.triggerMission`, bypassing the suspend/resume plumbing that chat/agent
  triggers use (BullMQ-backed). If the mission hits a step that needs a human — captcha, login,
  free-text confirmation — the promise resolves with `{ status: 'waiting', message: '...' }`
  instead of actually pausing and waiting. It does not hang until a human answers. If your mission
  might need HIL, trigger it through a chat/agent flow instead of calling `browser.run()` directly.
- **`cancel()` is cooperative, not preemptive.** The backend only checks for a pending cancel
  request in between agentic-loop steps (each step is one LLM call plus one browser action) — it
  cannot interrupt a step already in flight. Expect roughly one step's worth of delay (an LLM call
  plus a page action) before the mission actually stops after you call `cancel()`.
- **`cancel()` can only ever target your own tenant's mission.** `session_id` is checked against the
  caller's tenant server-side and rejected on mismatch — it exists as a self-check convenience (so
  you can pass back exactly what `run()` gave you) and cannot be used to cancel a different tenant's
  running mission.
- There is still no way to stream intermediate progress (step-by-step logs) back to the calling
  plugin code — that data only reaches the chat UI's live screencast via a separate socket channel,
  not through this SDK call. `run()` only resolves once, with the final result.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
