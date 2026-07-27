# 🧩 `code` — execute AI-generated/cached business logic

The `code` namespace runs arbitrary "business logic" (a plain-language `logic` description that the
platform generates, caches, and executes as real code) with sandboxed `args`. Reach for it when a
plugin needs to perform a one-off computation/transform that's easier to describe than to hand-code,
and wants the platform to generate/cache/execute it rather than shipping the logic itself.

## Import

```typescript
import { code } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.code
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `executeLogic` | `params: { logic: string; args?: any; input_schema?: Record<string, string> }` | `Promise<any>` | Calls `code.executeLogic`. Executes `logic` (a plain-language description, up to 50,000 chars) against `args`, generating and caching the underlying implementation on first use. `input_schema` describes each arg's type/meaning and is used to suggest arg names to the code generator. Identity is always taken from `ctx.user`, never from `params`. |

## `executeLogic` example

```typescript
import { code } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const result = await code.executeLogic({
    logic: 'Given a list of order totals, return the sum, average, and the count of orders over $100',
    args: { orders: input.orders },
    input_schema: { orders: 'array of numbers - order totals in USD' },
  });

  return { status: 'success', data: result };
}
```

## Notes & caveats

- `logic` is capped at 50,000 characters server-side (`ExecuteBusinessLogicRequest.logic`).
- The generated implementation is cached and reused across calls with the same `logic` (and
  compatible `args` shape) — the exact reuse/cache-key behavior is a backend implementation detail
  not exposed to the caller.
- `args` is validated server-side against an internal "safe args" check before execution — expect
  arbitrary/unsafe payloads to be rejected rather than silently sanitized.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
