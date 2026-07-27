# 🔗 `causality` — deep causal reasoning

The `causality` namespace drives the platform's deep causal-reasoning engine: `think` runs a deep
reasoning pass over accumulated context to answer a query, and `absorb` feeds new causal facts back
into that accumulated context for future reasoning. Reach for it when a plugin needs
multi-step "why/because" style reasoning rather than a single LLM completion, or needs to persist
causal knowledge it has derived for later reuse.

## Import

```typescript
import { causality } from '@aivin/sdk';
// equally: ctx.sdk.causality / import SDK from '@aivin/sdk'; SDK.causality
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `think` | `query: string`, `opts?: Record<string, any>` | `Promise<any>` | Runs a deep causal-reasoning pass over accumulated context to answer `query`. Maps to `think.deep`, with `opts` **spread directly** into the call params alongside `query` (i.e. `{ query, ...opts }`), not nested under a sub-key. |
| `absorb` | `causalities: any[]`, `opts?: Record<string, any>` | `Promise<any>` | Feeds new causal facts (`causalities`) back into the reasoning engine's accumulated context. Maps to `think.absorb`, with `opts` spread directly into the call params (`{ causalities, ...opts }`). |

## `think` example

```typescript
import { causality } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  const answer = await causality.think('Why did conversion rate drop last week?', {
    workspace_id: ctx.workspace?.id,
  });

  return { status: 'success', data: answer };
}
```

## `absorb` example

```typescript
import { causality } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  const result = await causality.absorb(
    [
      { cause: 'checkout latency spike', effect: 'conversion rate drop', confidence: 0.8 },
    ],
    { workspace_id: ctx.workspace?.id },
  );

  return { status: 'success', data: result };
}
```

## Notes & caveats

- This matches the real `get causality()` in `src/base/SDK.ts` **exactly** — both `think` and
  `absorb` spread their `opts` directly into the call params (`this.call('think.deep', { query,
  ...opts })` / `this.call('think.absorb', { causalities, ...opts })`), rather than nesting them
  under a `mission`/`context` sub-key.
- **There is no separate `think` namespace with `deep`/`search` sub-methods on the real SDK.** That
  shape was invented from `CodeSDK.d.ts`'s declared-but-unimplemented `think.*` overloads and does
  not exist on the backend — use `causality.think(...)` (which itself calls the `think.deep`
  namespace under the hood), not a standalone `think.deep(...)` / `think.search(...)`.
- Both `opts` and the individual entries of `causalities` are typed as `any`/`Record<string, any>`
  in `SDKClient.ts` — there is no fixed schema confirmed for either; shape what you pass based on
  what your reasoning use case needs and verify against actual responses.

## See also

- [SDK Reference](../SDK.md) — the full `ctx.sdk` surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
