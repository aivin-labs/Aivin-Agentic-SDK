# Single Method Plugin Pattern

## Overview

A **single-function** plugin (the normal case, and what this doc is about) exposes exactly **one**
entry point: `main`. The platform triggers your container, the host resolves your handler's entry
point (`main`, then default export, then first exported function, in that order), and your code
routes internally on whatever input it receives. This is the pattern to reach for unless you
specifically have several small, related functions that would otherwise duplicate a project's worth
of boilerplate between them - for that case, see
[multi-function plugins](./MANIFEST.md#multi-function-plugins), where `manifest.json` names several
functions in one shared `src/main.ts` instead of one.

```typescript
import { PluginStatus } from '@aivin-labs/sdk';
import type { PluginInput, PluginContext, PluginResponse } from '@aivin-labs/sdk';

export async function main(
  mission: string,
  input: PluginInput,
  ctx: PluginContext,
): Promise<PluginResponse> {
  // All of your plugin's logic lives here.
  return { status: PluginStatus.SUCCESS, data: {/* ... */}, message: 'Processed successfully' };
}
```

- `mission` — human-readable reason this run was triggered (for logging, not routing).
- `input` — the fields described in `manifest.json`'s `input`.
- `ctx` — `user`, `workspace`, `session`, `cert` (connected-account credentials, if
  `manifest.connection_id` is set), and `sdk` (the full platform surface — see [SDK.md](./SDK.md)).

## Why single-method

Keeping one entry point per plugin means:

- One manifest, one handler file, no routing table to keep in sync.
- The host's trigger contract stays simple: same `Invoke` RPC, same resolution rule, every time.
- Branching on `input.action`/similar inside `main()` (see below) covers the same use cases a
  multi-function manifest would, without a second layer of dispatch.

## Examples

### Simple, single-purpose plugin

```typescript
export async function main(mission, input, ctx) {
  const { text, operation = 'uppercase' } = input;
  const result =
    operation === 'uppercase'
      ? text.toUpperCase()
      : operation === 'lowercase'
        ? text.toLowerCase()
        : operation === 'reverse'
          ? text.split('').reverse().join('')
          : text;

  return { status: 'success', data: result };
}
```

### Multi-action plugin (branch inside `main`)

```typescript
export async function main(mission, input, ctx) {
  switch (input.action) {
    case 'create':
      return createItem(ctx, input);
    case 'list':
      return listItems(ctx, input);
    default:
      return { status: 'fail', message: `Unknown action: ${input.action}` };
  }
}

async function createItem(ctx, { title }) {
  const row = await ctx.sdk.store.set('items', crypto.randomUUID(), {
    title,
    createdAt: Date.now(),
  });
  return { status: 'success', data: row };
}

async function listItems(ctx, { limit = 20 }) {
  const rows = await ctx.sdk.store.query('items', {}, { createdAt: -1 }, limit);
  return { status: 'success', data: rows };
}
```

### Default export (also valid)

```typescript
export default async function (mission, input, ctx) {
  const results = [];
  for (const step of input.workflow.steps) {
    results.push(await ctx.sdk.call(step.namespace, { ...step.params, data: input.data }));
  }
  return { status: 'success', data: { steps_completed: results.length, results } };
}
```

## Best practices

- **Keep `main` focused.** Route on an explicit `input.action`/`input.type` field rather than
  trying to infer intent from arbitrary shaped input — it's easier for the AI planner (and future
  you) to call correctly.
- **Delegate to the platform, don't reimplement it.** Use `ctx.sdk.task.create(...)`,
  `ctx.sdk.notification.push(...)`, etc. instead of hand-rolling equivalents — you get tenant
  scoping and observability for free.
- **Use `status`/`error_code`, not ad-hoc shapes.** Returning `PluginResponse`'s
  `{ status: PluginStatus.X, ... }` (rather than an invented `{ success: boolean }` shape) is what
  downstream tooling (agentic planner, retry/replan logic) actually reads.

```typescript
import { PluginStatus, PluginErrorCode } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  try {
    const result = await ctx.sdk.call('server.process', input.data);
    return { status: PluginStatus.SUCCESS, data: result };
  } catch (error) {
    ctx.sdk.log(`processing failed: ${error.message}`, 'error');
    return {
      status: PluginStatus.ERROR,
      message: 'Unable to process request',
      error_code: PluginErrorCode.EXECUTION_FAILED,
    };
  }
}
```

## Local development workflow

```bash
aivin create my-plugin
cd my-plugin

# edit src/main.ts
aivin start                                       # local gRPC server + HTTP test shim

curl -X POST http://localhost:4001/invoke \
  -H 'content-type: application/json' \
  -d '{"input": {"action": "list"}}'

aivin test                                        # deploy to a test instance
aivin deploy                                      # ship it
```
