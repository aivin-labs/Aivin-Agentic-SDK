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
import { browser } from '@aivin/sdk';
// equally: ctx.sdk.browser / import SDK from '@aivin/sdk'; SDK.browser
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `run` | `mission: string, opts?: { start_url?: string; success_criteria?: string[]; steps?: string[]; output_schema?: Record<string, any>; [key: string]: any }` | `Promise<any>` | Calls `browser.run` with `{ mission, data: opts }`. Runs a full self-correcting AI Browser mission described by `mission`, optionally seeded with a starting URL, explicit success criteria, suggested steps, and/or a schema the final output should conform to. |

## `run` example

```typescript
import { browser } from '@aivin/sdk';

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

## Notes & caveats

- `browser.run()` is NOT a lightweight call — it drives a full multi-step, self-correcting agent
  session against a real browser. Expect materially higher latency (and cost) than any other
  namespace in this SDK; don't call it in a tight loop or as a substitute for a simple fetch.
- The return type is `any` in `SDKClient.ts` — there is no confirmed fixed shape for the mission
  result. If you pass `output_schema`, the result is expected to conform to it, but that's a
  request to the mission runner, not a client-side guarantee — validate the shape you get back
  before trusting it.
- `opts` carries an open `[key: string]: any` index signature in addition to the four named,
  documented fields (`start_url`, `success_criteria`, `steps`, `output_schema`) — any other keys
  you add are passed straight through to the backend without client-side validation.
- The call is built as `{ mission, data: opts }` — i.e. everything you pass as the second argument
  is nested under `data` in the actual RPC payload, not sent flat alongside `mission`.

## See also

- [SDK Reference](../SDK.md) — the full `ctx.sdk` surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
