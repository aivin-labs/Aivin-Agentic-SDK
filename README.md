# 🚀 Aivin Plugin SDK

[![npm version](https://badge.fury.io/js/%40aivin%2Fsdk.svg)](https://badge.fury.io/js/%40aivin%2Fsdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)

## About Aivin

[Aivin](https://aivin.cloud) is an **AI Workforce Platform**: it gives a business a team of virtual
**AI Staff** that actually run its processes, not just answer questions about them. Humans and AI
work side by side in one environment built for both — high-performance, parallel, secure, and
reliable — so AI Staff can stay on a job for the long haul instead of losing context after one
exchange.

That workforce doesn't stay static. It adapts and keeps learning as it works, building a deeper
understanding of the organization over time — less a chatbot bolted onto the business, more a
second brain growing alongside it. And it doesn't work in isolation: Aivin connects broadly and
deeply into the tools a business already runs on.

Plugins are that connection. Every plugin you ship becomes a new, real-world skill any AI Staff
agent in the workspace can discover and call on its own — the platform is architected to scale to
**millions of them**. Whenever an agent needs to do something beyond reasoning alone — query a
database, call a CRM, run a browser task, generate a report — it calls out to a plugin, and
**this SDK is how you build one**.

**Write one file, ship a plugin.** The Aivin Plugin SDK is the official toolkit for building
plugins that run as their own Docker container inside the platform, with full access to the
agentic engine, LLM/embeddings, vector search, tasks, persistent storage, realtime events, and
everything else the platform offers — through one clean, fully-typed SDK surface.

You write `src/main.ts`. The SDK, CLI, and platform handle the container, the transport, the auth,
and the infrastructure.

```typescript
import { ai } from '@aivin/sdk';
import { PluginStatus } from '@aivin/sdk';
import type { PluginInput, PluginContext, PluginResponse } from '@aivin/sdk';

export async function main(
  mission: string,
  input: PluginInput,
  ctx: PluginContext,
): Promise<PluginResponse> {
  const summary = await ai.prompt(`Summarize: ${input.text}`);
  return { status: PluginStatus.SUCCESS, data: summary };
}
```

## Table of Contents

- [Why the Aivin SDK](#why-the-aivin-sdk)
- [Requirements](#requirements)
- [Getting Started](#getting-started)
- [Anatomy of a plugin](#anatomy-of-a-plugin)
- [Three equivalent ways to call the SDK](#three-equivalent-ways-to-call-the-sdk)
- [What the SDK exposes](#what-the-sdk-exposes)
- [manifest.json](#manifestjson)
- [How AI Staff discovers your plugin](#how-ai-staff-discovers-your-plugin)
- [CLI reference](#cli-reference)
- [Environment variables](#environment-variables)
- [How it works](#how-it-works)
- [Security model](#security-model)
- [Turn anything into a plugin](#turn-anything-into-a-plugin)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Why the Aivin SDK

- **From empty folder to deployed plugin in four commands.** `aivin create` → write `src/main.ts`
  → `aivin start` to test → `aivin deploy` to ship. No Dockerfile, no CI pipeline, no server to
  provision, no infra config to write — the CLI packages your code and the host builds and runs
  the container for you.
- **Your AI Staff finds it on its own.** You don't register routes, intents, or a tool schema by
  hand. The platform's agentic planner reads `manifest.json`'s `selection_rules`/`description`/
  `capabilities` and decides on its own, at run time, which plugin fits the job — see
  [How AI Staff discovers your plugin](#how-ai-staff-discovers-your-plugin).
- **Turn anything into a plugin.** Write custom logic in `src/main.ts`, convert a project you
  already have with `aivin plugin convert`, or skip code entirely and proxy straight through to an
  existing external system (an MCP server today via `aivin mcp create`; the manifest schema also
  recognizes REST, n8n, Zapier, Make, Coze, Dify, and workflow proxies configured through the
  platform dashboard) — whichever way, it becomes something every AI Staff agent in the workspace
  can call like any other native capability.
- **One entry point.** Export a single `main(mission, input, ctx)` function — the SDK's plugin
  server resolves it (falling back to a default export, then the first exported function) and
  handles everything else.
- **Fully typed, zero boilerplate.** `PluginInput`, `PluginContext`, `PluginResponse`, and every
  SDK namespace ship with complete TypeScript types generated straight from the platform's own SDK
  contract — your editor tells you what's available before you run anything.
- **No credentials for you to manage.** `redis`/`mongo`/`store` are host-mediated, tenant-scoped
  storage — call them directly, no connection strings to configure, rotate, or keep out of your
  repo, and nothing sensitive sitting in your container to leak.
- **Test before you deploy.** `aivin start` runs the real gRPC server locally plus a `curl`-able
  HTTP shim, so you can exercise your handler end-to-end without ever touching the platform.
- **AI can write it for you.** `aivin plugin make "<description>"` generates a working
  `src/main.ts` from a plain-language description, or `aivin plugin convert` generates one from a
  project you already have.

## Requirements

| | |
| --- | --- |
| **Node.js** | ≥ 22.0.0 (native TypeScript execution support; stable from Node 22.6, default from Node 24) |
| **Package manager** | npm (or any Node package manager) |
| **Docker** | Not required locally — the platform builds and runs your container remotely on `aivin deploy` |
| **Account** | An Aivin account, for `aivin login` / `aivin deploy` / `aivin test` |

## Getting Started

Four steps, four commands each — from an empty folder to a plugin every AI Staff agent in your
workspace can already discover and call.

### 1. Initialize

```bash
npm install -g @aivin/sdk

aivin create my-plugin
cd my-plugin && npm install
```

### 2. Write

Edit `src/main.ts` — the only file you need (full walkthrough:
[Anatomy of a plugin](#anatomy-of-a-plugin)). Or skip writing it yourself:

```bash
aivin plugin make "Summarize a support ticket and tag its urgency"
# or, converting a project you already have instead of starting from a description:
aivin plugin convert
```

### 3. Run it locally

```bash
npm start        # real gRPC server + a curl-friendly HTTP test shim on :4001

curl -X POST http://localhost:4001/invoke -H 'content-type: application/json' \
  -d '{"input":{"text":"Aivin plugins are easy to write."}}'
```

### 4. Deploy

```bash
aivin login    # save your API key (once per machine)
aivin test      # verify on a non-production instance first
aivin deploy    # ships to your org
```

No Dockerfile, no CI pipeline, no server to provision — the CLI packages `src/main.ts` +
`manifest.json` and the platform builds and runs the container.

## Anatomy of a plugin

`aivin create` scaffolds everything you need:

```
my-plugin/
├── manifest.json      # name, description, input/output shape, triggers
├── src/
│   └── main.ts         # your one entry point — main(mission, input, ctx)
├── package.json
├── tsconfig.json
├── .env                # local-only overrides, e.g. LOCAL_TEST_PORT (never committed)
└── .gitignore
```

`src/main.ts` is the only file you write. Export exactly one `main` function:

```typescript
import { ai, store } from '@aivin/sdk';
import { PluginStatus, PluginErrorCode } from '@aivin/sdk';
import type { PluginInput, PluginContext, PluginResponse } from '@aivin/sdk';

export async function main(
  mission: string,          // human-readable reason this run was triggered (for logging)
  input: PluginInput,       // fields declared in manifest.json's "input"
  ctx: PluginContext,       // user, workspace, session, cert (if connection_id set), sdk
): Promise<PluginResponse> {
  if (!input.text) {
    return { status: PluginStatus.FAIL, error_code: PluginErrorCode.INVALID_INPUT };
  }

  const summary = await ai.prompt(`Summarize: ${input.text}`);
  await store.set('summaries', crypto.randomUUID(), { summary, created_at: Date.now() });

  return { status: PluginStatus.SUCCESS, data: summary, message: 'Processed successfully' };
}
```

Need more than one entry point? Export as many named functions as you like from the same
`src/main.ts` and list each one's `func` in `manifest.json`'s `plugins: [...]` field instead of a
single object — see [manifest.json](#manifestjson).

More real, complete examples (RAG search, task automation, persistent storage, agent delegation,
human-in-the-loop review): [docs/EXAMPLES.md](docs/EXAMPLES.md).

## Three equivalent ways to call the SDK

Every style resolves to the exact same per-invocation client (same tenant scoping, same capability
token) — pick whichever reads best in your code:

```typescript
// 1. Import just the namespace(s) you need (preferred)
import { ai, mongo } from '@aivin/sdk';
await ai.prompt('Hello');

// 2. Default import — the whole client as one object
import SDK from '@aivin/sdk';
await SDK.ai.prompt('Hello');

// 3. Via ctx (3rd argument of main()) — no import needed
export async function main(mission, input, ctx) {
  return { status: 'success', data: await ctx.sdk.ai.prompt('Hello') };
}
```

Full details, including the generic `call('namespace.method', params)` escape hatch:
[docs/SDK.md](docs/SDK.md#three-equivalent-ways-to-reach-it).

## What the SDK exposes

Every namespace below is importable on its own — `import { ai, store } from '@aivin/sdk'` — and
equally reachable via `ctx.sdk` if you'd rather not import it (see
[Three equivalent ways to call the SDK](#three-equivalent-ways-to-call-the-sdk)).

| Namespace | Purpose | Details |
| --- | --- | --- |
| `ai` | Prompt the LLM, generate embeddings, rerank documents | [docs/sdk/ai.md](docs/sdk/ai.md) |
| `knowledge` | Search the workspace's long-term knowledge base (RAG) | [docs/sdk/knowledge.md](docs/sdk/knowledge.md) |
| `vector` | Raw vector search and indexing over the workspace's document store | [docs/sdk/vector.md](docs/sdk/vector.md) |
| `store` | Persistent storage, recommended default — relational key-value with schema, graph edges, hybrid search, aggregation, atomic transactions | [docs/sdk/store.md](docs/sdk/store.md) |
| `redis` | Simple isolated key-value cache | [docs/sdk/redis.md](docs/sdk/redis.md) |
| `mongo` | Isolated, Mongoose-style document collections | [docs/sdk/mongo.md](docs/sdk/mongo.md) |
| `datastore` | Project-scoped tabular database (tables/rows) — separate from `store` | [docs/sdk/datastore.md](docs/sdk/datastore.md) |
| `datasource` | Manage training data sources feeding the workspace's knowledge | [docs/sdk/datasource.md](docs/sdk/datasource.md) |
| `task` | Create, update, list, and delete tasks | [docs/sdk/task.md](docs/sdk/task.md) |
| `project` | Read-only project lookup | [docs/sdk/project.md](docs/sdk/project.md) |
| `workspace` | Workspace details, members, permissions, per-workspace plugin config | [docs/sdk/workspace.md](docs/sdk/workspace.md) |
| `agent` | Look up an AI Staff agent, check its status, or delegate work to it | [docs/sdk/agent.md](docs/sdk/agent.md) |
| `message` | Save, list, search, and update chat messages | [docs/sdk/message.md](docs/sdk/message.md) |
| `session` | Chat/automation session management | [docs/sdk/session.md](docs/sdk/session.md) |
| `realtime` | Publish a live event to the workspace or a specific user | [docs/sdk/realtime.md](docs/sdk/realtime.md) |
| `queue` | Schedule this same plugin to run again later (self-continuation) | [docs/sdk/queue.md](docs/sdk/queue.md) |
| `notification` | Push in-app notifications and send transactional email | [docs/sdk/notification.md](docs/sdk/notification.md) |
| `resource` | Upload or remove blob storage files | [docs/sdk/resource.md](docs/sdk/resource.md) |
| `file` | Create, read, list, and search workspace documents | [docs/sdk/file.md](docs/sdk/file.md) |
| `setting` | Read tenant display/merchant settings | [docs/sdk/setting.md](docs/sdk/setting.md) |
| `usage` | Check billing balance and usage | [docs/sdk/usage.md](docs/sdk/usage.md) |
| `automation` | Manage cron-style automation jobs | [docs/sdk/automation.md](docs/sdk/automation.md) |
| `browser` | Trigger a full, multi-step AI Browser mission | [docs/sdk/browser.md](docs/sdk/browser.md) |
| `causality` | Deep causal reasoning over accumulated context | [docs/sdk/causality.md](docs/sdk/causality.md) |
| `attachment` | Search, deep-research, and evaluate attached documents | [docs/sdk/attachment.md](docs/sdk/attachment.md) |

A few top-level functions round out the surface, imported the same way: `ask(...)`/`hil(...)` for
human-in-the-loop input, `a2a(...)` for agent delegation, `user(id)` for a user's public profile,
`log(...)`/`wait(...)`, and the read-only `config` getter.

Every method is scoped to this plugin and the invoking tenant on the host side — your container
never receives a raw database credential. Full method-by-method reference with parameter shapes:
[docs/SDK.md](docs/SDK.md).

## `manifest.json`

The bare minimum — everything else in the table below is optional:

```json
{
  "id": "auto-generated-hex-id",
  "name": "text-summarizer",
  "description": "Summarize text using AI",
  "input": { "text": "string - text to summarize" },
  "output": { "data": "string - the summary" }
}
```

`manifest.json` is always **one JSON object**. For the normal case above (a single-function plugin)
that's the whole file — its one entry point is resolved from `src/main.ts`'s `main` export. For a
multi-function plugin, it's a *group*: shared fields (`version`, `connection_id`, ...) written once
at the top level, plus a `plugins` array holding each function's own config - `aivin deploy`/`aivin
test` copy the shared fields onto every entry automatically before sending. Each entry is a full
manifest plus a `func` field naming which export of the *same* shared `src/main.ts` it calls, and is
deployed/discovered as its own independent plugin `id`:

```json
{
  "version": "1.0.0",
  "author": "Your Name",
  "email": "you@example.com",
  "license": "MIT",
  "plugins": [
    {
      "id": "auto-generated-hex-id",
      "name": "summarize-ticket",
      "description": "Summarize a support ticket",
      "input": { "text": "string - ticket content" },
      "output": { "data": "string - the summary" },
      "func": "summarizeTicket"
    },
    {
      "id": "auto-generated-hex-id",
      "name": "tag-urgency",
      "description": "Tag a support ticket's urgency",
      "input": { "text": "string - ticket content" },
      "output": { "data": "string - urgency level" },
      "func": "tagUrgency"
    }
  ]
}
```

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Required. Unique identifier, lowercase-hyphen (`"task-manager"`). |
| `description` | `string` | Required. Short summary — one of the signals the planner reads to pick this plugin. |
| `selection_rules` | `string[]` | **The strongest discovery signal** — see [How AI Staff discovers your plugin](#how-ai-staff-discovers-your-plugin). |
| `input` | `object` | Required. Structure of the handler's 2nd argument — actually parsed and validated, not just descriptive text. Supports nested objects/arrays. Read by the planner's auto-mapping to fit its own output onto your fields. |
| `output` | `string \| object` | The shape of `PluginResponse.data` callers should expect. Read by the planner for auditing/replanning and for mapping this plugin's result into a later stage's input. |
| `func` | `string` | Multi-function manifests only. Name of the export in `src/main.ts` this `plugins[]` entry calls. |
| `instructions` | `string` | Extra planner guidance beyond `description` — edge cases, when *not* to use it. |
| `capabilities` | `string[]` | Free-text tags for discovery/ranking against other plugins. |
| `category` / `scope` | `string` / `string[]` | Single primary domain for display; broader domain tags as a secondary ranking signal. |
| `trigger_type` | `TriggerType[]` | Restrict invocation channels (`manual`/`schedule`/`event`/`webhook`/`api`/`chat`). Omit = all. |
| `initable` | `string[]` | Fields that must be configured once per workspace before the plugin can run (e.g. an API key). |
| `depend_on` | `string \| PluginDependency \| (...)[]` | Other plugin(s) this one depends on — the dependency is scheduled into an earlier execution stage, so it always runs (and its result is available) before this plugin does. A bare string is required; an object (`{ plugin, optional, condition, fallback_field }`) is conditional. |
| `mapping_reasoning` | `boolean \| string[]` | How the planner maps its output onto `input`'s fields: via LLM reasoning, direct key mapping, or a mix. |
| `connection_id` | `string` | Namespace for a shared connection — plugins sharing this id share one set of credentials. |
| `timeout_ms` | `number` | Execution timeout (the host also enforces its own hard cap). |
| `circuit_breaker` | `object` | Per-plugin override of the default failure threshold/cooldown. |
| `expose` | `string[]` | Field paths from this plugin exposed externally. |
| `stacks` | `string[]` | Dedicated service containers, only relevant outside shared-infrastructure deployments. |
| `requires_human` | `boolean` | Task fundamentally can't be automated — the planner marks it infeasible instead of substituting an automated plugin. |
| `request_hil` / `hard_confirm` | `boolean` | Human-in-the-loop / hard "action gate" safety flags for sensitive or irreversible actions. |
| `version` | `string` | Semantic version — `aivin deploy`/`aivin test` auto-increment the patch on success. |
| `author` | `string` | Your name. |
| `email` | `string` | Your contact email. |
| `license` | `string` | License name (e.g. `MIT`, `Apache-2.0`). |
| `repository_url` | `string` | Link to the plugin's source repo. |
| `compute_factor` | `number` | Relative resource weight vs. a baseline plugin (default `1`). |
| `side_effect` | `boolean` | Set `false` only for pure-read plugins (find/list/get/search). |
| `proxy_config` | `object` | Turns this into a proxy for an external system instead of running code — see [Turn anything into a plugin](#turn-anything-into-a-plugin). |

Full reference, including the `input`/`output` type-annotation syntax and every trigger type:
[docs/MANIFEST.md](docs/MANIFEST.md).

## How AI Staff discovers your plugin

You never wire up routing, intents, or a tool schema by hand. Every AI Staff agent's planner reads
your `manifest.json` and decides on its own, at run time, whether your plugin is the right tool for
the job — in roughly this order of weight:

- **`selection_rules`** — the strongest signal. Explicit, concrete triggering conditions, shown to
  the planner as `Rules: ...` right next to your `description` when it's picking between candidate
  plugins:
  ```json
  "selection_rules": [
    "Requests for high-fidelity 'deep research' across multiple sources",
    "Standard web search results are insufficient or overly superficial"
  ]
  ```
  Write the concrete conditions that should trigger this plugin, not a restatement of what it does
  — that's what `description` is for.
- **`description`** — the first thing the planner reads to decide when to reach for your plugin.
  Short and specific beats generic.
- **`capabilities`** — free-text tags used for discovery and ranking against every other plugin in
  the workspace.
- **`instructions`** — standing guidance for the AI on how to use this plugin, read at several points
  beyond initial selection: disambiguating between candidate plugins when it's unsure which one
  fits, mapping its own output onto your `input` schema, and auditing/replanning a mission that
  didn't go as expected. Edge cases and when *not* to use it belong here too.
- **`category`** — a single primary domain, for classification and display.
- **`requires_human`** — set `true` if the task fundamentally can't be automated; the planner then
  marks it infeasible instead of silently substituting an automated plugin.

Write these once in `manifest.json`, deploy, and any agent in the workspace — not just the one you
had in mind while building it — can find and call your plugin from then on.

## CLI reference

`aivin` is built on [Commander](https://github.com/tj/commander.js) — `aivin --help` and
`aivin <command> --help` are always available. Full reference with every flag and environment
variable: [docs/CLI.md](docs/CLI.md).

| Command | Description |
| --- | --- |
| `aivin create [name]` | Scaffold a new plugin (interactive, or `--json`/`--stdin` for scripted/AI use). |
| `aivin plugin make "<description>"` | AI-generate `src/main.ts` from a natural-language business description, already written against this SDK's namespaces. |
| `aivin plugin convert` | Already have a project? Turn it into a plugin — AI-generate `src/main.ts` from the code you already have, in the current directory. |
| `aivin plugin trigger "<mission>" '<input>'` | Invoke an already-deployed plugin for real and print the result — like the platform's Playground. `-a "<prompt>"` lets the platform auto-map free text onto the input schema instead. |
| `aivin validate --json <config>` | Validate a plugin config before creating/deploying. |
| `aivin start` | Run the plugin locally: real gRPC server + an HTTP test shim on `:4001`. |
| `aivin test` | Deploy to a non-production test instance, then smoke-test it with generated input and save a report to `.test/`. Blocked in production. |
| `aivin deploy` | Deploy to your org. |
| `aivin mcp create <name>` | Scaffold a manifest-only plugin that proxies to an external MCP server tool/resource/prompt — no code needed. |
| `aivin login` | Authenticate and save an API key to `~/.aivin/credentials` (once per machine, shared by every project). |

## Environment variables

`aivin login` saves your key once to `~/.aivin/credentials`, shared by every plugin project on the
machine — there's no per-project credential to manage.

| Variable | Purpose | Default |
| --- | --- | --- |
| `SDK_GRPC_ENDPOINT` | Backend gRPC endpoint for `ctx.sdk.*` calls | `api.aivin.cloud:50051` |
| `AIVIN_BASE_URL` | Aivin API base URL (only for a self-hosted/staging instance) | `https://api.aivin.cloud` |
| `AIVIN_WEB_URL` | Platform web app URL, used by `aivin login`'s browser flow | `https://brain.aivin.cloud` |
| `LOCAL_TEST_PORT` | Port for the local HTTP test shim (`POST /invoke`) | `4001` |

That's it — everything else is zero-config. Full list: [docs/CLI.md#environment-variables](docs/CLI.md#environment-variables).

## How it works

- Your plugin runs in its **own Docker container**, managed entirely by the Aivin host — you
  never touch Docker yourself, `aivin deploy` handles it.
- The host and your plugin talk over **gRPC**, one symmetric `Invoke` RPC in each direction: the
  host calls your container to run `main()`, and `ctx.sdk` calls back out to the host for
  everything else (LLM, vector search, storage, tasks, ...). Adding a new backend capability never
  requires a proto change — just a new `namespace` string on the host side.
- Every `Invoke` call carries a shared-secret bearer token, plus a short-lived, per-invocation
  **capability token** the host mints for each trigger — so the host always resolves your real
  tenant/workspace identity server-side, never from anything your process claims about itself.
- `src/main.ts` is loaded via Node's native TypeScript support, which is why `manifest.json`'s
  `trigger_type` and similar unions are plain `const` objects instead of TS `enum`s — only
  *erasable* TypeScript syntax is supported at runtime.

Full internals (proto shape, directory layout, auth flow, local testing without a host):
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). You don't need to read it to build a plugin.

## Security model

- **No raw credentials.** `store`/`redis`/`mongo` are host-mediated and tenant-scoped; your
  container never receives a database connection string.
- **Identity can't be spoofed.** The per-invocation capability token means your own code can never
  claim to be a different tenant, even though it shares a process with `ctx.sdk`.
- **Response size is capped.** Whatever `main()` returns is capped at **1MB** once
  JSON-serialized; page/paginate large result sets instead of returning everything at once.

## Turn anything into a plugin

You don't have to start from an empty `src/main.ts`, and you don't have to write any code at all if
you'd rather not.

**Already have a project?** Point `aivin plugin convert` at it and it becomes a plugin — no manual
wrapper code to write:

```bash
cd your-existing-project
aivin plugin convert
```

It reads your project as-is, infers a `manifest.json` from `package.json` if you don't have one yet,
and generates a `src/main.ts` that adapts your project's real logic into `main(mission, input, ctx)`
— preserving what it already does, not stubbing it out. Add a hint if you want to point it at
something specific: `aivin plugin convert "focus on the exportInvoice function"`. Review what it
generates before you deploy, same as any AI-written code.

**Just wrapping an external service?** Skip code entirely — the manifest's `proxy_config` turns an
existing external system into something every AI Staff agent can call directly, with no container
to build and no `src/main.ts` at all. This SDK authors the `mcp` variant for you: if your plugin's
job is just to expose an existing [MCP](https://modelcontextprotocol.io) server's tool, resource, or
prompt, skip straight to the manifest:

```bash
aivin mcp create fs-tools --command npx \
  --args "-y @modelcontextprotocol/server-filesystem /data" \
  --tool-name read_file --description "Read files via MCP"
```

`aivin deploy`/`aivin test` detect the resulting `proxy_config` automatically and send the manifest
alone — no files, no container build. The full `proxy_config` schema also recognizes REST, n8n,
Zapier, Make, Coze, Dify, and workflow proxies, configured through the platform dashboard — same
idea, for turning virtually any existing system into an agent-callable plugin without writing code.
Full reference, including the `sse` transport for remote MCP servers:
[docs/MANIFEST.md](docs/MANIFEST.md#mcp-proxy-plugins).

## Documentation

- 🧰 **[SDK Reference](docs/SDK.md)** — every namespace: AI, vector/knowledge, tasks, storage, realtime, and more
- 📋 **[Manifest Reference](docs/MANIFEST.md)** — every `manifest.json` field, including MCP proxy plugins
- 🖥️ **[CLI Reference](docs/CLI.md)** — every command, flag, and environment variable
- 📖 **[Plugin Development Guide](docs/PLUGIN_DEVELOPMENT_GUIDE.md)** — end-to-end walkthrough
- 🏗️ **[Architecture](docs/ARCHITECTURE.md)** — how the gRPC transport and container model work
- 📚 **[Examples](docs/EXAMPLES.md)** — real, complete plugins across common use cases
- 📊 **[Data Structures](docs/DATA_STRUCTURES.md)** — `User`, `Workspace`, `Task`, `PluginManifest`, and friends
- 📝 **[Changelog](docs/CHANGELOG.md)** — release history
- 🤝 **[Contributing](docs/CONTRIBUTING.md)**

For a quick, AI-agent-focused cheat sheet (the two files every plugin needs, in one page), see
[AI-Plugin-Guide.md](AI-Plugin-Guide.md).

## Contributing

Bug reports, feature requests, and pull requests are welcome — see
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for how to get involved.

## License

MIT © [Aivin Team](https://aivin.cloud)
