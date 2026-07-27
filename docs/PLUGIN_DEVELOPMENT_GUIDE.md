# 🔌 Aivin Plugin Development Guide

End-to-end walkthrough: from an empty folder to a deployed plugin.

## 1. Prerequisites

- Node.js >= 22 (the SDK relies on Node's native TypeScript support to load `src/main.ts` directly)
- `npm install -g @aivin/sdk`
- An Aivin account + API key (`aivin login`) once you're ready to deploy

## 2. Create the plugin

```bash
aivin create my-plugin
cd my-plugin
npm install
```

This scaffolds:

```
my-plugin/
├── manifest.json      # identity, input/output description, trigger types
├── src/
│   └── main.ts         # your one entry point: main()
├── package.json        # depends only on @aivin/sdk; `npm start` runs `aivin start`
├── tsconfig.json        # editor/type-checking config (not used to build anything at deploy time)
├── .env                 # local-only config (see step 4)
└── .gitignore
```

Read [MANIFEST.md](./MANIFEST.md) for the full field reference — the important ones to fill in
right away are `description` (also what the AI planner reads to decide when to use your plugin)
and `input`/`output` (free-form, but the clearer the better).

## 3. Write the handler

Every plugin exports exactly one entry point, `main`:

```typescript
import { PluginStatus } from '@aivin/sdk';
import type { PluginInput, PluginContext, PluginResponse } from '@aivin/sdk';

export async function main(
  mission: string,
  input: PluginInput,
  ctx: PluginContext,
): Promise<PluginResponse> {
  const summary = await ctx.sdk.ai.prompt(`Summarize: ${input.text}`);
  return { status: PluginStatus.SUCCESS, data: summary };
}
```

- `mission` — human-readable reason this run was triggered (for logging, not routing).
- `input` — whatever was described in `manifest.json`'s `input`.
- `ctx.user` / `ctx.workspace` / `ctx.session` — who/where this run belongs to.
- `ctx.cert` — connected-account credentials, only present if `manifest.connection_id` is set.
- `ctx.sdk` — the full platform surface. See [SDK.md](./SDK.md) for every namespace (`ai`,
  `vector`, `knowledge`, `task`, `store`, `redis`, `mongo`, `workspace`, `agent`, `realtime`,
  `queue`, and more). `import SDK from '@aivin/sdk'` is an equivalent alternative if you'd rather
  not thread `ctx` through your own helper functions.

### Let AI write it for you

```bash
aivin plugin make "Summarize a support ticket and tag its urgency"
```

This calls the platform's AI code generator, prompted specifically to reinforce this SDK's
conventions (`main(mission, input, ctx)`, `ctx.sdk.*`, `PluginResponse`/`PluginStatus` return
shape). Review the output before relying on it — generated code is a strong starting point, not a
guarantee.

## 4. Test locally

```bash
aivin start
```

This starts two things:

1. A real gRPC server on `:50051` — the same protocol the production host uses to trigger your
   plugin. You generally won't call this directly.
2. In development, an HTTP test shim on `:4001` for quick manual testing:

```bash
curl -X POST http://localhost:4001/invoke \
  -H 'content-type: application/json' \
  -d '{"input": {"text": "Some text to summarize"}}'
```

`ctx.sdk.*` calls made during local testing default to the **production** backend
(`api.aivin.cloud`) if `SDK_GRPC_ENDPOINT` isn't set — so `ai.prompt(...)` etc. work out of the box,
against real production data. Point `.env` at a local/dev backend instead if you don't want that:

```bash
# .env
SDK_GRPC_ENDPOINT=localhost:50051   # a local/dev Aivin backend
SDK_GRPC_SECRET=
```

A one-time warning is logged whenever the production default is used, so it's never silent.

## 5. Deploy

```bash
aivin login                # once per machine - saves an API key to ~/.aivin/credentials
aivin test                  # deploy to a non-production test instance first
aivin deploy                # ship to your org
```

Each successful deploy auto-increments `manifest.json`'s patch version. `aivin test` uses the same
payload but a different (non-production-only) endpoint, so you can verify your plugin runs
correctly on real infrastructure — real container, real gRPC, real `ctx.sdk` — before it's visible
to anyone. It then goes a step further: it generates sample input from your `input` schema, actually
invokes the plugin, and writes a pass/fail report to `.test/<timestamp>.json` — pass `--workspace
<id>` to pick which workspace it runs against, or `--no-smoke-test` to skip this and just deploy.

Not every plugin needs custom code, either — `aivin mcp create <name>` scaffolds a manifest-only
plugin that just proxies to an external MCP server's tool/resource/prompt. `aivin deploy`/`aivin test`
detect this automatically and skip the code upload entirely. See
[MANIFEST.md#mcp-proxy-plugins](./MANIFEST.md#mcp-proxy-plugins).

## 6. Best practices

**Keep `main` focused.** Route on an explicit field (`action`, `type`) rather than inferring intent
from loosely-shaped input.

**Delegate, don't reimplement.** `task.create(...)`, `notification.push(...)`, etc. give you tenant
scoping and observability for free — there's no lower-level API to drop down to even if you wanted
to (you never receive raw database credentials).

**Fail soft for expected cases.**

```typescript
import { call, log } from '@aivin/sdk';
import { PluginStatus, PluginErrorCode } from '@aivin/sdk';

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

**Self-schedule instead of managing your own queue.** `ctx.sdk.queue.scheduleJob({ input, delay_ms })`
re-invokes your own `main()` later — you never manage BullMQ/Redis directly.

**Respect the response size limit.** Whatever `main()` returns is capped at 1MB (JSON-serialized)
by the host; paginate large result sets rather than returning everything at once.

## 7. Troubleshooting

| Symptom                                                             | Likely cause                                                                                                                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.sdk.*` calls seem to hit production unexpectedly               | Expected if `SDK_GRPC_ENDPOINT` isn't set in `.env` — it defaults to `api.aivin.cloud`. Set it to a local/dev backend if that's not what you want — see step 4. |
| `aivin start` fails with `EADDRINUSE` on the gRPC port              | Something else (possibly another plugin instance) already owns `:50051`. Set `SDK_GRPC_SERVER_BIND=127.0.0.1:<other-port>`.                                     |
| Local HTTP test shim didn't start, but the gRPC server did          | The shim failing to bind (e.g. port `:4001` taken) never takes down the real server — check the log line, set `LOCAL_TEST_PORT` to something free.              |
| `aivin deploy`/`aivin test` fails with 401/403                      | Run `aivin login` again - it saves a fresh key to `~/.aivin/credentials`, shared by every project.                                                              |
| Generated code from `aivin plugin make` doesn't compile/looks wrong | Review and edit — it's AI-generated, treat it like a first draft from a junior contributor.                                                                     |

## See also

- [CLI.md](./CLI.md) — every `aivin` command, option, and env var
- [SDK.md](./SDK.md) — every `ctx.sdk` namespace
- [MANIFEST.md](./MANIFEST.md) — every manifest field
- [SINGLE_METHOD_PLUGINS.md](./SINGLE_METHOD_PLUGINS.md) — handler pattern in depth
- [EXAMPLES.md](./EXAMPLES.md) — real plugins across common use cases
- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the transport works, for the curious
