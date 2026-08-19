# 🔌 Aivin Plugin Development Guide

How to write, test, and reason about a plugin's actual logic — the SDK side of building a plugin.
For scaffolding a project, running it locally, and deploying it, see
[`@aivin-labs/cli`'s Getting Started guide](https://github.com/aivin-labs/cli/blob/main/docs/GETTING_STARTED.md)
instead; this doc assumes you already have a project (`aivin create`/`aivin init`) and picks up
from there.

## Anatomy of a plugin

```
my-plugin/
├── manifest.json      # shared fields + plugins[] — identity, input/output description, triggers
├── src/
│   └── main.ts         # your entry point: main(mission, input, ctx)
├── package.json        # depends only on @aivin-labs/sdk
├── tsconfig.json        # editor/type-checking config (not used to build anything at deploy time)
└── .env                 # local-only config
```

Read [MANIFEST.md](./MANIFEST.md) for the full field reference — the important ones to fill in
right away are `description` (also what the AI planner reads to decide when to use your plugin)
and `input`/`output` (free-form, but the clearer the better).

## Write the handler

Every plugin exports exactly one entry point, `main`:

```typescript
import { ai, PluginStatus } from '@aivin-labs/sdk';
import type { PluginInput, PluginContext, PluginResponse } from '@aivin-labs/sdk';

export async function main(
  mission: string,
  input: PluginInput,
  ctx: PluginContext,
): Promise<PluginResponse> {
  const summary = await ai.prompt(`Summarize: ${input.text}`);
  return { status: PluginStatus.SUCCESS, data: summary };
}
```

- `mission` — human-readable reason this run was triggered (for logging, not routing).
- `input` — whatever was described in `manifest.json`'s `input`.
- `ctx.user` / `ctx.workspace` / `ctx.session` — who/where this run belongs to.
- `ctx.cert` — connected-account credentials, only present if `manifest.connection_id` is set.
- The platform surface itself is imported, not taken from `ctx`: `import { ai, vector, task, ... }
  from '@aivin-labs/sdk'`. See [SDK.md](./SDK.md) for every namespace (`ai`, `vector`, `knowledge`,
  `task`, `store`, `redis`, `mongo`, `workspace`, `agent`, `realtime`, `queue`, and more).
  (`ctx.sdk` is the legacy handle to the same client — still works, not recommended.)

Read [CONTEXT.md](./CONTEXT.md) for the full `ctx` field reference (`org_id`, `client`, `config`,
`metadata`, when each field is present, and usage patterns).

Using `aivin init`'s `src/service.ts` split instead of a plain `src/main.ts`? The signature is the
same minus the response envelope — `execute(input, ctx): Promise<any>`, returning plain result data
or throwing a plain `Error` on failure. The generated `src/main.ts` wrapper packages that into
`PluginResponse` for you; you never touch `PluginStatus`/`PluginErrorCode` in `service.ts` itself.

### Let AI write it for you

The platform's AI code generator can write `main()`/`execute()` from a plain-language description,
reinforced to follow this SDK's conventions (`main(mission, input, ctx)`, `import { ai } from
'@aivin-labs/sdk'`, the `PluginResponse`/`PluginStatus` return shape). Driven from the CLI —
`aivin plugin make "<description>"` — see
[`@aivin-labs/cli`'s docs](https://github.com/aivin-labs/cli/blob/main/docs/GETTING_STARTED.md#3-write-or-regenerate-the-handler)
for the command itself. Review generated output before relying on it — it's a strong starting
point, not a guarantee.

## Test with mocks — no network, no running server

```bash
npm test
```

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockSDK, withMockSDK, createMockContext } from '@aivin-labs/sdk';
import { main } from '../src/main.ts';

test('main() returns a success response', async () => {
  const { client, calls } = createMockSDK({
    handlers: {
      // One entry per namespace.method your plugin actually calls. Missing one throws
      // immediately with a clear message naming it - that's the signal to add it here.
      'ai.prompt': async ({ quest }) => `Echo: ${quest}`,
    },
  });
  const ctx = createMockContext(client);

  const result = await withMockSDK(client, () => main('test mission', { text: 'hello' }, ctx));

  assert.equal(result.status, 'success');
  assert.equal(calls[0]?.namespace, 'ai.prompt');
});
```

`withMockSDK` matters even if your code only reads `ctx.sdk` today — wrap the call anyway so
`import { ai } from '@aivin-labs/sdk'`-style code (the recommended style; see [Write the
handler](#write-the-handler) above) resolves to your mock too, not just `ctx.sdk` directly. Keep
this file in sync as you change what your plugin calls/returns — a stale test that still passes
because it mocks the wrong thing is worse than no test.

`aivin create`/`aivin init` already scaffold a working example of this (`test/main.test.ts` or
`test/service.test.ts`) — the snippet above is what that file looks like.

## Local runtime behavior

Running your handler against a real gRPC server locally (`aivin start`, from the CLI) is a CLI
concern — see its
[Getting Started guide, step 4](https://github.com/aivin-labs/cli/blob/main/docs/GETTING_STARTED.md#4-test-locally).
What's worth knowing on the SDK side:

- **SDK calls made during local testing default to the production backend**
  (`api.aivin.cloud`) if `SDK_ENDPOINT` isn't set — so `ai.prompt(...)` etc. work out of the box,
  against real production data. Point `.env` at a local/dev backend instead if you don't want that
  (`SDK_ENDPOINT=localhost:50051`, `SDK_SECRET=`). A one-time warning is logged whenever the
  production default is used, so it's never silent — see `GrpcInvoker.resolveEndpoint`.
- **There is no host to mint a real invocation identity locally** — `ctx.user`/`ctx.workspace`/
  `ctx.session` are whatever the test request supplies (usually absent). Write your handler to
  tolerate that; see [CONTEXT.md](./CONTEXT.md#local-testing-aivin-start).
- **Per-call tracing** (`SDK_DEBUG=true`/`json`, surfaced as `aivin start --debug`/`--debug-json`
  from the CLI) is a thin env-var wrapper around `withTrace`/`onCall` — see
  [SDK.md#debugging--tracing](./SDK.md#debugging--tracing) for the programmatic API underneath, if
  you're embedding the SDK's runtime yourself rather than using `aivin start`.

## Best practices

**Keep `main` focused.** Route on an explicit field (`action`, `type`) rather than inferring intent
from loosely-shaped input.

**Delegate, don't reimplement.** `task.create(...)`, `notification.push(...)`, etc. give you tenant
scoping and observability for free — there's no lower-level API to drop down to even if you wanted
to (you never receive raw database credentials).

**Fail soft for expected cases.**

```typescript
import { call, log } from '@aivin-labs/sdk';
import { PluginStatus, PluginErrorCode } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  try {
    const result = await call('server.process', input);
    return { status: PluginStatus.SUCCESS, data: result };
  } catch (error) {
    log(`processing failed: ${error.message}`, 'error');
    return {
      status: PluginStatus.ERROR,
      message: 'Unable to process request',
      error_code: PluginErrorCode.EXECUTION_FAILED,
    };
  }
}
```

**Self-schedule instead of managing your own queue.** `queue.scheduleJob({ input, delay_ms })`
re-invokes your own `main()` later — you never manage BullMQ/Redis directly.

**Respect the response size limit.** Whatever `main()` returns is capped at 1MB (JSON-serialized)
by the host; paginate large result sets rather than returning everything at once.

**Don't cache per-invocation state at module scope.** Your container isn't restarted between calls -
it stays warm and serves many invocations in a row, possibly from different workspaces/tenants, over
the *same* running process (`PluginServer` only re-imports your code on a fresh deploy, never
per-call). Anything you assign to a module-level variable (outside `main()`) persists across those
calls. `ctx.sdk`/the capability token are already scoped correctly per-invocation by the host - the
risk is code you write yourself, e.g. caching `ctx.sdk` or a request's data in a top-level `let` "to
save a lookup next time." Keep anything invocation-specific inside `main()`'s own scope; module-level
state is fine only for things that are genuinely safe to share across every caller (e.g. a
compiled regex, a pure lookup table).

**Design side effects to be safely repeatable.** A Docker-runtime invocation can be retried on a
*different* node if the one running it dies mid-call (BullMQ `attempts: 3` with exponential backoff,
plus a stalled-job reroute that can fire before all 3 attempts are even used - see
`WorkerPluginJobConsumer`/`BullIO` on the backend) - and each plugin container is capped at
128MB/0.25 CPU, tight enough that a memory-heavy call can genuinely get OOM-killed mid-invocation in
practice, not just in theory. There's currently no invocation-level idempotency key threaded through
to your code to detect "this is a retry of a call I already made." If `main()` calls something
non-idempotent (sends an email, charges a payment, posts to an external webhook), design that call to
tolerate running twice - e.g. have the *downstream* system dedupe on a key you derive deterministically
from the input, since you can't rely on this invocation only ever happening once.

## Troubleshooting (SDK/handler-side)

| Symptom | Likely cause |
| --- | --- |
| SDK calls seem to hit production unexpectedly | Expected if `SDK_ENDPOINT` isn't set in `.env` — it defaults to `api.aivin.cloud`. Set it to a local/dev backend if that's not what you want — see [Local runtime behavior](#local-runtime-behavior). |
| A namespace method throws `[namespace.method] invalid params` immediately, no network call made | Zod-validated namespaces (`automation.*`, `resource.*`, `store.*`, `table.*`) reject a bad shape before ever calling the host — check the field named in the error against [SDK.md](./SDK.md) or the namespace's own `docs/sdk/*.md` page. |
| A call's shape is right but the result looks wrong | Check the relevant `docs/sdk/*.md` page's "Notes & caveats" — several namespaces have real field names/behavior that differ from what the SDK's own declared types (or intuition) would suggest, e.g. `automation.createJob` takes `mission`/`schedule_condition`, not `name`/`schedule`. |
| Generated code from `aivin plugin make` doesn't compile/looks wrong | Review and edit — it's AI-generated, treat it like a first draft from a junior contributor. |

CLI-side issues (`aivin start`/`deploy`/`login` failing, port conflicts, auth errors) belong in
[`@aivin-labs/cli`'s own troubleshooting section](https://github.com/aivin-labs/cli/blob/main/docs/GETTING_STARTED.md#8-troubleshooting)
instead.

## See also

- [SDK.md](./SDK.md) — every SDK namespace
- [MANIFEST.md](./MANIFEST.md) — every manifest field
- [CONTEXT.md](./CONTEXT.md) — the `ctx` argument in depth
- [SINGLE_METHOD_PLUGINS.md](./SINGLE_METHOD_PLUGINS.md) — handler pattern in depth
- [EXAMPLES.md](./EXAMPLES.md) — real plugins across common use cases
- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the transport works, for the curious
- [`@aivin-labs/cli` Getting Started guide](https://github.com/aivin-labs/cli/blob/main/docs/GETTING_STARTED.md) — scaffolding, running locally, deploying
