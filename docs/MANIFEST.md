# 📋 Manifest File Documentation

`manifest.json` describes your plugin to the platform — its identity, what it expects/returns, and
how it's allowed to run. It mirrors the backend's `DeveloperPluginManifest`
(`src/plugins/dto/PluginDTO.ts`) field-for-field; anything not listed here is assigned by the
platform itself (`id`, `is_verified`, `is_official`, `store_status`, `verification_status`,
`network_config`, `checksum`, `rate_limit`, ...) and shouldn't be set by hand.

## Minimal example

```json
{
  "id": "auto-generated-hex-id",
  "name": "text-summarizer",
  "description": "Summarize text using AI",
  "version": "1.0.0",
  "author": "Your Name",
  "email": "you@example.com",
  "input": { "text": "string - text to summarize" },
  "output": { "data": "string - the summary" },
  "trigger_type": ["manual", "api", "chat"]
}
```

## Fields

| Field                        | Type                                                           | Required  | Description                                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | `string`                                                       | ✅ (auto) | Assigned by `aivin create`; the platform confirms/rewrites it on first deploy. Never edit by hand.                                                                                                                               |
| `name`                       | `string`                                                       | ✅        | Unique identifier, lowercase-hyphen (`"task-manager"`).                                                                                                                                                                          |
| `description`                | `string`                                                       | ✅        | Short, human-readable summary — also what the AI planner reads to decide when to use this plugin.                                                                                                                                |
| `version`                    | `string`                                                       | —         | Semantic version. `aivin deploy`/`aivin test` auto-increment the patch on success.                                                                                                                                               |
| `author`                     | `string`                                                       | —         | Your name.                                                                                                                                                                                                                         |
| `email`                      | `string`                                                       | —         | Your contact email.                                                                                                                                                                                                                |
| `input`                      | `object`                                                       | ✅        | Structure of the handler's 2nd argument (`input`) - see [Field type convention](#field-type-convention) below. Not a strict JSON Schema, but it IS actually parsed/validated by the platform (`PluginDataHelper`), not just descriptive text. Supports nested objects/arrays. Read by the planner's auto-mapping (see `mapping_reasoning` below) to fit its own output onto your fields. |
| `output`                     | `string \| object`                                             | —         | Describes the actual data your plugin returns — `PluginResponse`'s `data` field (and any other fields callers should expect) — not a generic wrapper description. Read by the planner for auditing/replanning and for mapping this plugin's result into a later stage's input. |
| `instructions`               | `string`                                                       | —         | Standing guidance for the AI on how to use this plugin — read beyond initial selection too: disambiguating between candidates, mapping its output onto `input`, and auditing/replanning a mission that didn't go as expected.   |
| `capabilities`               | `string[]`                                                     | —         | Free-text capability tags used for discovery/ranking.                                                                                                                                                                            |
| `selection_rules`            | `string[]`                                                     | —         | **The strongest discovery signal.** Explicit natural-language triggering conditions, shown to the planner as `Rules: ...` right next to `description` when it picks between candidate plugins — weighted above `capabilities`/`instructions`. See [How AI Staff discovers your plugin](../README.md#how-ai-staff-discovers-your-plugin). |
| `initable`                   | `string[]`                                                     | —         | Fields that must be configured once per workspace before the plugin can run (e.g. an API key) — surfaced to the user as a setup prompt.                                                                                          |
| `depend_on`                  | `string \| PluginDependency \| (string \| PluginDependency)[]` | —         | Other plugin(s) this one depends on — the dependency is scheduled into an earlier execution stage, so it always runs (and its result is available) before this plugin does. A bare string is required; an object (`{ plugin, optional, condition, fallback_field }`) is conditional. |
| `mapping_reasoning`          | `boolean \| string[]`                                          | —         | How the planner maps its output onto `input` before calling this plugin: `true` = every field via LLM reasoning; `string[]` = only those fields via reasoning, rest mapped directly by key; omitted = all fields mapped directly by key. |
| `connection_id`              | `string`                                                       | —         | Namespace for a shared connection — plugins with the same `connection_id` share one set of credentials.                                                                                                                          |
| `timeout_ms`                 | `number`                                                       | —         | Execution timeout. The host also enforces its own hard cap regardless of this value.                                                                                                                                             |
| `circuit_breaker`            | `object`                                                       | —         | Per-plugin override of the default circuit breaker: `fail_threshold` (default `3`), `window_sec` (default `300`), `cooldown_sec` (default `60`).                                                                                 |
| `expose`                     | `string[]`                                                     | —         | Field paths from this plugin's data exposed externally (dynamic API / selection context).                                                                                                                                        |
| `stacks`                     | `string[]`                                                     | —         | Dedicated service containers (`"REDIS_CACHE"`, `"MONGODB"`, `"BACKGROUND_JOBS"`, `"REALTIME_COMMUNICATION"`) provisioned alongside this plugin's container instead of shared, host-mediated storage. Only relevant outside shared-infrastructure deployments — omit for the normal case. |
| `trigger_type`               | `TriggerType[]`                                                | —         | Restricts which channels can invoke this plugin: `manual`, `schedule`, `event`, `webhook`, `api`, `chat`. **Omit it entirely to allow all channels** — this is the normal default, not something you need to fill in explicitly. |
| `initial`                    | `object`                                                       | —         | Default config values.                                                                                                                                                                                                           |
| `scope`                      | `string[]`                                                     | —         | Business domains this plugin applies to (ranking signal), e.g. `["finance", "sales"]`.                                                                                                                                           |
| `category`                   | `string`                                                       | —         | Single primary domain for display/classification.                                                                                                                                                                                |
| `metadata`                   | `object`                                                       | —         | Free-form extra info (complexity, use case, etc.).                                                                                                                                                                               |
| `license`                    | `string`                                                       | —         | License name (e.g. `MIT`, `Apache-2.0`).                                                                                                                                                                                          |
| `repository_url`             | `string`                                                       | —         | Link to the plugin's source repo.                                                                                                                                                                                                 |
| `compute_factor`             | `number`                                                       | —         | Relative resource weight vs. a baseline plugin (default `1`); affects usage accounting.                                                                                                                                          |
| `side_effect`                | `boolean`                                                      | —         | Set `false` only for pure-read plugins (find/list/get/search). Default (unset) = assumed to have side effects, for safe retry behavior.                                                                                          |
| `requires_human`             | `boolean`                                                      | —         | Set `true` if this task fundamentally needs a human in the loop (can't be fully automated) — the agentic planner marks it infeasible rather than substituting an automated plugin.                                               |
| `request_hil`                | `boolean`                                                      | —         | Marks this plugin as sensitive, requiring human-in-the-loop review before running. Usually assigned automatically by the platform's own indexing/audit process rather than set by hand.                                          |
| `hard_confirm`               | `boolean`                                                      | —         | "Action gate" — only a human admin sets this (never the LLM or an automated audit), for severe/irreversible actions. Unlike `request_hil`, it has no bypass and blocks entirely on automation/system-triggered channels.          |
| `proxy_config`                | `object`                                                       | —         | Set this to proxy an external system instead of running code — see [MCP proxy plugins](#mcp-proxy-plugins) below. Only the `mcp` variant is meant to be authored through this SDK.                                              |

## Multi-function plugins

`manifest.json` is always **one JSON object**, never a bare array. For a plugin that exposes more
than one function, that object is a group: fields shared by every function written once, plus a
`plugins` array holding each function's own config:

| Field     | Type    | Required | Description                                                                                                     |
| --------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `plugins` | `array` | ✅       | One entry per function. Each entry is a partial manifest (all the same fields from [Fields](#fields) apply) plus a required `func`. |

Every field *outside* `plugins` (`version`, `author`, `email`, `license`, `connection_id`, ...) is
copied onto each entry in `plugins` before anything else processes this file -
an entry's own value wins if it sets the same field itself. Each entry also needs its own `func`:

| Field  | Type     | Required (per entry) | Description                                                                                   |
| ------ | -------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| `func` | `string` | ✅                     | Name of the exported function in the shared `src/main.ts` that this entry calls, e.g. `"summarizeTicket"` for `export async function summarizeTicket(mission, input, ctx) { ... }`. |

Each entry is deployed and discovered as its **own independent plugin `id`** — its own entry in the
plugin store/catalog, with its own `description`/`selection_rules`/`input`/`output`/etc. for the
planner — even though every entry shares one uploaded `src/main.ts` and **one running container**.
`aivin deploy`/`aivin test` upload the code once; every entry's `proxy_config.code_id` (assigned by
the platform) points at that same shared container, so N plugin ids all route to it.

Resolution at invocation time (`PluginServer.resolveTargetFunction`): the host already knows exactly
which entry (`id`) was triggered before it ever calls into the container, so it sends that entry's
`func` explicitly with the request — the container just calls `handler[func]` directly, no local
guessing needed. The one place local matching still applies is `aivin start` (no real host in the
loop): pass `mission` matching an entry's `id` (or `func` directly) to pick which one runs, for
manual `curl` testing across every function in one dev-mode process — see
[`aivin start`](./CLI.md#aivin-start).

### Example

```typescript
// src/main.ts — two named exports, no `main`/default export needed
import { ai } from '@aivin/sdk';
import { PluginStatus } from '@aivin/sdk';
import type { PluginInput, PluginContext, PluginResponse } from '@aivin/sdk';

export async function summarizeTicket(
  mission: string,
  input: PluginInput,
  ctx: PluginContext,
): Promise<PluginResponse> {
  const summary = await ai.prompt(`Summarize this support ticket:\n\n${input.text}`);
  return { status: PluginStatus.SUCCESS, data: summary };
}

export async function tagUrgency(
  mission: string,
  input: PluginInput,
  ctx: PluginContext,
): Promise<PluginResponse> {
  const urgency = await ai.prompt(
    `Classify the urgency of this support ticket as low/medium/high:\n\n${input.text}`,
  );
  return { status: PluginStatus.SUCCESS, data: urgency };
}
```

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
      "output": { "data": "string - urgency level (low/medium/high)" },
      "func": "tagUrgency"
    }
  ]
}
```

Each of these deploys/discovers as a fully separate plugin (`summarize-ticket` and `tag-urgency`),
each independently callable and rankable by the planner, both backed by the one `src/main.ts` above
and sharing the `version`/`author`/`email`/`license` written once at the top level.

### When to use this vs. separate plugin projects

Reach for a multi-function manifest when you have several small, related functions that logically
belong together and would otherwise duplicate most of their boilerplate/config (shared
`connection_id`, dependencies, `package.json`, deploy pipeline, ...) across separate
`aivin create` projects. If the functions are unrelated or independently versioned/owned, prefer
separate plugin projects instead.

### See also

- [../README.md#manifestjson](../README.md#manifestjson) — the same feature introduced with a
  quick-start example
- [Fields](#fields) — the full per-entry field reference every array entry draws from

## Field type convention

`input`/`output` aren't just descriptive - the platform actually parses and validates against them
(the same engine the agentic planner uses to check for missing/invalid fields before calling your
plugin), so the shape below is a real contract, not a suggestion.

**Leaf field**: `"field_name": "type - description"`

```json
{ "email": "string - recipient address" }
```

- Optional: add `?` to the end of either the field name or the type - `"cc?"` and `"cc": "string? - ..."` are equivalent.
- If a value is missing/empty and the field isn't optional, the platform blocks the call before your `main()` ever runs.

**Enum**: use type `enum`, and declare the allowed values (and optionally a default) inside the description itself:

```json
{ "status": "enum - order status. enum: pending, paid, cancelled. default: pending" }
```

The values after `enum:` are comma/pipe/slash-separated and read up to the next `.`/`;`/newline.
Don't describe fixed choices as `"string - 'a' or 'b'"` - that isn't parsed as a constraint at all,
just prose; use `enum` so the platform can actually enforce it.

**Nested object**: value is a plain object (recurses the same rules):

```json
{ "address": { "city": "string - city name", "zip?": "string - postal code" } }
```

**Array**: value is a one-element array - `[<leaf schema>]` for a list of primitives, or `[{...}]` for a list of objects:

```json
{ "tags": ["string - a tag"], "items": [{ "sku": "string - product sku", "qty": "number - quantity" }] }
```

**Valid `type` tokens**:

| Type                     | Checks                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `string`                  | Non-empty (the default/fallback type if omitted).                                            |
| `number` / `int` / `float` | Numeric.                                                                                     |
| `boolean` / `bool`        | `true`/`false`/`1`/`0`.                                                                       |
| `email`                   | Valid email format.                                                                           |
| `phone`                   | Valid phone number format.                                                                    |
| `url`                     | Valid URL.                                                                                     |
| `password`                | >6 chars, needs upper+lowercase+special char.                                                 |
| `id`                      | Non-empty string.                                                                              |
| `uuid`                    | UUID format.                                                                                    |
| `date` / `datetime`       | Parseable date with a 4-digit year.                                                            |
| `file`                    | Presence check only - actual file handling is upload-layer concern.                            |
| `json`                    | Valid JSON string.                                                                              |
| `object`                  | An object (or a JSON string of one).                                                           |
| `any`                     | Always passes.                                                                                  |
| `enum`                    | Value must be one of the options declared in the description (see above).                      |
| `agent` / `project` / `member` | Must exist in the current workspace - a workspace-entity lookup, not a format check.       |

## Handler resolution

`main()` is always the entry point the host calls. If it's missing, the default export is used;
failing that, the first exported function. Only one of these should exist per `src/main.ts` — see
[SINGLE_METHOD_PLUGINS.md](./SINGLE_METHOD_PLUGINS.md). This resolution order applies to a
single-function plugin (`manifest.json` is one object); see [Multi-function
plugins](#multi-function-plugins) below for the `plugins: [...]` case, which resolves differently.

```typescript
export async function main(
  mission: string,
  input: PluginInput,
  ctx: PluginContext,
): Promise<PluginResponse> {
  return { status: PluginStatus.SUCCESS, data: {/* ... */}, message: 'Processed successfully' };
}
```

## Trigger Types

| Trigger    | Description                                           |
| ---------- | ----------------------------------------------------- |
| `manual`   | User-triggered (button, form).                        |
| `schedule` | Cron-style periodic invocation.                       |
| `event`    | Triggered by a data change or webhook-adjacent event. |
| `webhook`  | External HTTP request.                                |
| `api`      | Direct programmatic call.                             |
| `chat`     | Invoked from a chat/agent conversation.               |

## MCP proxy plugins

A plugin can also just forward calls to an existing [MCP](https://modelcontextprotocol.io) server
instead of running your own code — one of its tools, resources, or prompts becomes callable like
any other plugin, with no `src/main.ts` at all:

```bash
aivin mcp create doc-search \
  --url https://example.com/mcp --tool-name search_docs \
  --description "Search external docs via MCP"
```

This writes a manifest-only plugin — just `manifest.json`, no `src/main.ts`/`package.json`:

```json
{
  "id": "auto-generated-hex-id",
  "name": "doc-search",
  "description": "Search external docs via MCP",
  "version": "1.0.0",
  "input": { "data": "object - parameters forwarded to the MCP tool/resource/prompt as-is" },
  "output": { "data": "object - the MCP server response content, unwrapped" },
  "proxy_config": {
    "type": "mcp",
    "mcp_transport": "sse",
    "mcp_url": "https://example.com/mcp",
    "mcp_kind": "tool",
    "mcp_tool_name": "search_docs"
  }
}
```

`aivin deploy`/`aivin test` detect `proxy_config` automatically and send the manifest alone — no
code is uploaded or scanned.

| `proxy_config` field                    | Applies when                | Description                                                                                        |
| ---------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `type`                                   | always                        | Always `"mcp"` for plugins created through `aivin mcp create`.                                     |
| `mcp_transport`                          | always                        | `"stdio"` (launch a local command) or `"sse"` (remote Streamable HTTP server).                     |
| `mcp_command` / `mcp_args`               | `mcp_transport: "stdio"`      | Command (+ args) that launches the MCP server.                                                      |
| `mcp_url`                                | `mcp_transport: "sse"`        | URL of the remote MCP server.                                                                       |
| `mcp_kind`                               | always                        | `"tool"` (default), `"resource"`, or `"prompt"` — decides which MCP JSON-RPC method gets called.    |
| `mcp_tool_name`                          | `mcp_kind: "tool"`            | The real tool name per the MCP protocol.                                                            |
| `mcp_resource_uri` / `mcp_resource_mime_type` | `mcp_kind: "resource"`   | URI (and optional MIME type) of the resource.                                                       |
| `mcp_prompt_name`                        | `mcp_kind: "prompt"`          | The real prompt name per the MCP protocol.                                                          |
| `auth_secret_key`                        | server requires auth          | Name of a secret already stored in your workspace's credential store, used as the Bearer token — never the raw secret itself. |

Run `aivin mcp create <name>` without any options for an interactive prompt instead, or pass
`--json`-style flags (see `aivin mcp create --help`) to script it.

The platform also supports other proxy types server-side (REST, n8n, Coze, Dify, ...) — those are
configured through the dashboard, not through this SDK.

## Common mistakes

| ❌ Wrong                     | ✅ Right                                    | Why                                                                                |
| ---------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `"name": "My Plugin"`        | `"name": "my-plugin"`                       | Must be lowercase, hyphen-separated.                                               |
| Hand-editing `"id"`          | Let `aivin create`/`aivin deploy` manage it | The platform owns plugin identity.                                                 |
| `"functions": [...]`         | `"plugins": [...]`                          | `functions` isn't a recognized field — see [Multi-function plugins](#multi-function-plugins).      |
| `manifest.json` as a bare `[...]` array | `{ "plugins": [...] }` (shared fields at the top level) | `manifest.json` is always one JSON object — see [Multi-function plugins](#multi-function-plugins). |

## Related

- **[SDK Reference](./SDK.md)** — what your handler can call
- **[Single Method Pattern](./SINGLE_METHOD_PLUGINS.md)** — handler conventions
- **[Examples](./EXAMPLES.md)** — full manifest + `src/main.ts` pairs
