# 🚀 Aivin Plugin SDK — AI Guide

Short reference for an AI agent (or developer) generating an Aivin plugin quickly and correctly.

## The two files every plugin needs

### `manifest.json`

```json
{
  "version": "1.0.0",
  "author": "",
  "email": "",
  "plugins": [
    {
      "id": "auto-generated-hex-id",
      "name": "plugin-name",
      "description": "What this plugin does",
      "func": "main",
      "input": { "field": "type - description" },
      "output": { "data": "type - description of what main() returns in PluginResponse.data" }
    }
  ]
}
```

`trigger_type` is optional — omitting it means the plugin is open to all trigger channels
(manual, schedule, event, webhook, api, chat). Only set it if you need to _restrict_ channels.

Need more than one function? Append more `plugins: []` entries — each is a full manifest plus a
`func` field naming which export of the shared `src/main.ts` it calls, and deploys as its own
independent plugin `id`. See
[MANIFEST.md#multi-function-plugins](./MANIFEST.md#multi-function-plugins).

Full field list: [MANIFEST.md](./MANIFEST.md).

### `src/main.ts`

Export exactly **one** entry point named `main`, with three parameters:

```typescript
import { ai } from '@aivin-labs/sdk';
import { PluginStatus, PluginErrorCode } from '@aivin-labs/sdk';
import type { PluginInput, PluginContext, PluginResponse } from '@aivin-labs/sdk';

export async function main(
  mission: string,
  input: PluginInput,
  ctx: PluginContext,
): Promise<PluginResponse> {
  // mission: human-readable reason this run was triggered (for logging, not routing)
  // input:   fields described in manifest.json's "input"
  // ctx:     user, workspace, session, cert (if connection_id is set)

  return {
    status: PluginStatus.SUCCESS,
    data: {/* result */},
    message: 'Processed successfully',
  };
}
```

**Import just the namespace(s) you use** — this is the preferred style:

```typescript
import { ai, vector, knowledge, task, store, redis, mongo } from '@aivin-labs/sdk';

ai.prompt(quest, opts)              // call the LLM
vector.search({ query })            // semantic search
knowledge.search(query)             // RAG over the workspace knowledge base
task.create({ title, ... })         // create a task
store.set(table, key, data)         // persistent, tenant-scoped storage
redis.get/set(key, value)           // simple cache
mongo.model(name).find(...)         // Mongoose-style isolated collection
```

`ctx.sdk.<namespace>.<method>` is the legacy way to reach the same client — still works, but
do not generate new code with it. Full reference:
[SDK.md](./SDK.md).

For anything without a dedicated import, use the generic escape hatch:
`import { call } from '@aivin-labs/sdk'; call('namespace.method', params)`.

## Trigger types

`manual` | `schedule` | `event` | `webhook` | `api` | `chat` — omit `trigger_type` to allow all.

## CLI workflow

```bash
aivin init my-plugin                # asks what it should do, scaffolds + generates real code in one step
cd my-plugin && npm install
# writes src/service.ts (business logic, AI-generated) + src/main.ts (thin static wrapper)

# alternative: scaffold with no AI step, write src/main.ts by hand
aivin create my-plugin
cd my-plugin
aivin plugin make "<description>"   # or: let AI generate the logic from a description
aivin plugin convert                # or: convert a project you already have into a plugin

aivin plugin search "<query>"       # check if an existing plugin already does this, first
aivin start                         # run locally: gRPC server + curl-able HTTP shim on :4001
aivin test                          # deploy to a non-production test instance
aivin deploy                        # ship to your org
aivin plugin trigger "<mission>" '<input>'  # invoke it for real, like the platform's Playground
```

## Checklist before deploying

- [ ] `manifest.json`: `name` is lowercase-hyphen, `description`/`input`/`output` are clear
- [ ] `output` describes the actual `data` shape `main()` returns, not a generic wrapper
- [ ] `src/main.ts` exports `main(mission, input, ctx)`, always returns a `PluginResponse`
      (`{ status: PluginStatus.X, data?, message?, error_code? }`)
- [ ] No hardcoded secrets — nothing to hardcode anyway, since `mongo`/`redis`/`store` never
      expose raw credentials
- [ ] Tested via `aivin start` + the `/invoke` HTTP shim before `aivin deploy`

## See also

- [SDK.md](./SDK.md) — every namespace, and all three ways to import them
- [MANIFEST.md](./MANIFEST.md) — every manifest field
- [SINGLE_METHOD_PLUGINS.md](./SINGLE_METHOD_PLUGINS.md) — handler pattern + more examples
- [EXAMPLES.md](./EXAMPLES.md) — real plugins across common use cases
