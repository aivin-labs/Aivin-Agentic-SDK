# 🧰 SDK Reference

Every call your plugin makes to the Aivin platform goes through the same client — mirrors the
platform's own SDK contract (`CodeSDK.d.ts`), so anything documented here works exactly the same
for every plugin.

**Preferred style: import just the namespaces you use.**

```typescript
import { ai, mongo } from '@aivin-labs/sdk';
import { PluginStatus } from '@aivin-labs/sdk';
import type { PluginInput, PluginContext, PluginResponse } from '@aivin-labs/sdk';

export async function main(
  mission: string,
  input: PluginInput,
  ctx: PluginContext,
): Promise<PluginResponse> {
  const summary = await ai.prompt(`Summarize: ${input.text}`);
  const Users = mongo.model('users');
  await Users.create({ summary, created_at: new Date() });
  return { status: PluginStatus.SUCCESS, data: summary };
}
```

## Calling the SDK

Import just the namespace(s) you need and call their shorthand methods — this is the one style to
use in any code you write or generate:

```typescript
import { ai, mongo } from '@aivin-labs/sdk';

await ai.prompt('Hello');
mongo.model('users').find({});
```

Every import resolves to the same per-invocation client (same tenant scoping, same capability
token) — nothing to construct or pass around.

(A generic `call('namespace.method', params)` escape hatch exists under the hood — `import { call }
from '@aivin-labs/sdk'` — but only reach for it when a namespace has no sugar method yet; see the
notes per section below.)

### Legacy: `ctx.sdk`

Older plugins reach the same client through `main()`'s 3rd argument (`ctx.sdk.ai.prompt(...)`).
It still works — same client, same call, same cost — but it's **not recommended**: the SDK is
designed so your logic doesn't have to depend on `ctx`. Don't write or generate new code with it.

Its one remaining niche: the imports only resolve while a `main()` invocation is actively running
(backed by `AsyncLocalStorage`, scoped per-invocation) and throw a clear error outside that
window, so code that isn't guaranteed to run inside `main()`'s async context still needs the
`ctx.sdk` reference handed to it.

## AI & LLM — `ai`

Full reference: [sdk/ai.md](./sdk/ai.md).

All four verified against the backend's real `get ai()` (`src/base/SDK.ts`) - `getEmbeddings` and
`rerank` in particular take different shapes than the old (wrong) docs implied.

| Method                          | Description                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt(quest, opts?)`            | Generate text / run LLM logic. `opts`: `model`, `temperature`, `max_tokens`, `schema` (force JSON output), `reasoning`, `websearch`. |
| `getEmbedding(text, opts?)`       | Single embedding vector. `text` may be a string or a string array.                                                                    |
| `getEmbeddings(texts, opts?)`     | Batch embeddings — faster than looping `getEmbedding`. `texts` is a plain array, not wrapped in an object.                          |
| `rerank(query, docs, opts?)`      | Re-rank a list of documents by relevance to `query`.                                                                                 |

`tts`/`stt`/`getModels`/`calculateTokens` are not confirmed to exist as sugar - use
`call('ai.tts', ...)` etc. directly if you need them.

## Knowledge & Vector (RAG) — `knowledge`, `vector`

Full reference: [sdk/knowledge.md](./sdk/knowledge.md), [sdk/vector.md](./sdk/vector.md).

| Method                                                 | Description                                                              |
| -------------------------------------------------------| ------------------------------------------------------------------------ |
| `knowledge.search(query, opts?)`                       | Search the workspace's long-term knowledge base.                         |
| `vector.search({ query, type?, limit?, threshold? })`  | Raw vector search over the workspace's document cluster (Milvus-backed). |
| `vector.index({ content, type?, id?, metadata? })`     | Index a document for vector search.                                      |

`knowledge.store`/`.get`/`.del`/`.reinforce` are not confirmed to exist as sugar - use
`call('knowledge.storeKnowledge', ...)` etc. directly if you need them.

## Workspace, Users, Agents — `workspace`, `agent`

Full reference: [sdk/workspace.md](./sdk/workspace.md), [sdk/agent.md](./sdk/agent.md).

| Method                                                    | Description                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `workspace.get(id)`                                       | Full workspace details.                                                        |
| `workspace.getByIds(ids)`                                 | Multiple workspaces at once.                                                   |
| `workspace.getMembers()`                                  | Member list for the current workspace.                                         |
| `workspace.checkPermission({ user_id?, permission })`     | Permission check for a member.                                                 |
| `workspace.getPluginConfig({ plugin_id, workspace_id? })` | Read this plugin's saved per-workspace config.                                 |
| `workspace.searchAgents({ query, limit?, threshold? })`   | Semantic search for an AI Staff agent by description.                          |
| `agent.get(id?)`                                          | Get an AI Staff agent (defaults to the current one).                           |
| `agent.status(id?)`                                       | Current run status for an agent.                                              |
| `agent.cancel(sessionId, threadId?)`                      | Cancel an in-flight agent response.                                           |
| `agent.delegate(target, data, purpose)`                   | Hand off a task to another agent (by ID or search query - auto-resolved via `workspace.searchAgents` if `target` doesn't look like an ID) and await its result. Same as top-level `a2a()`. |
| `user(id)`                                        | Public profile for a user in the current tenant.                               |

`agent.ask`/`agent.hil` don't exist - use the top-level `ask(...)`/`hil(...)` instead
(see below).

## Tasks & Projects — `task`, `project`

Full reference: [sdk/task.md](./sdk/task.md), [sdk/project.md](./sdk/project.md).

| Method                                                         | Description                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------|
| `task.create(params)`                                          | Create a task.                                                     |
| `task.update(taskId, data)`                                    | Update by ID - `taskId` is a separate argument, not part of `data`. |
| `task.getById(taskId)`                                         | Fetch by ID.                                                        |
| `task.delete(taskId)`                                          | Delete by ID.                                                       |
| `task.list(params)` / `.listMine(params?)`                     | List tasks / tasks assigned to the current user.                   |
| `project.get({ id })` / `.search({ workspace_id?, keyword? })` | Read-only project lookup.                                          |

## Persistent storage — `store`, `redis`, `mongo`

Full reference: [sdk/store.md](./sdk/store.md), [sdk/redis.md](./sdk/redis.md), [sdk/mongo.md](./sdk/mongo.md).

All three are **scoped to this plugin + tenant on the host** — you never receive raw database
credentials, so there's nothing to leak even if the container is compromised.

- **`store`** — the recommended default. A relational key-value store with schema, graph edges
  (`link`/`unlink`/`getLinks`), semantic/keyword/hybrid `search`, `aggregate`, cursor pagination,
  and atomic `transaction`.
  ```typescript
  await store.set('orders', orderId, { total, status: 'paid' });
  const recent = await store.query('orders', { status: 'paid' }, { created_at: -1 }, 20);
  ```
- **`redis`** — simple isolated key-value cache (`get/set/setex/incr/hget/hset/...`) when `store` is overkill.
- **`mongo`** — isolated document collections (`insert/find/update/aggregate/...`) for teams that prefer Mongo query shapes.

## Realtime & background work — `realtime`, `queue`

Full reference: [sdk/realtime.md](./sdk/realtime.md), [sdk/queue.md](./sdk/queue.md).

| Method                                       | Description                                                                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `realtime.publish({ event, data, target? })` | Push a live event to the workspace or current user (`target` defaults to workspace; the host resolves the real recipient — you can't target an arbitrary tenant). |
| `queue.scheduleJob({ input, delay_ms? })`    | Schedule a call to _this same plugin_ later (self-continuation) — the host re-invokes `main()` with `input` after `delay_ms`.                                     |

## Files, notifications, settings

Full reference: [sdk/file.md](./sdk/file.md), [sdk/resource.md](./sdk/resource.md),
[sdk/notification.md](./sdk/notification.md), [sdk/setting.md](./sdk/setting.md),
[sdk/session.md](./sdk/session.md), [sdk/usage.md](./sdk/usage.md),
[sdk/automation.md](./sdk/automation.md), [sdk/datastore.md](./sdk/datastore.md),
[sdk/datasource.md](./sdk/datasource.md), [sdk/browser.md](./sdk/browser.md),
[sdk/causality.md](./sdk/causality.md), [sdk/attachment.md](./sdk/attachment.md).

| Method                                                                                                   | Description                                                              |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `file.create/.get/.del/.list/.search`                                                                    | Workspace documents.                                                     |
| `resource.upload({ file, name?, mime? })` / `.remove({ url })`                                           | Blob storage.                                                            |
| `notification.push({ user_id, title, body, type? })`                                                     | In-app notification.                                                     |
| `notification.sendMail({ to, subject, body })`                                                           | Transactional email.                                                     |
| `setting.get(params?)` / `.getMerchantConfig()`                                                          | Tenant display/merchant settings.                                        |
| `session.get/.getList/.update/.create/.updateStatus`                                                     | Chat session management.                                                 |
| `usage.checkBalance()` / `.getUsage()`                                                                   | Billing/quota info.                                                      |
| `automation.createJob/.updateJob/.getJobs/.deleteJob/.executeById`                                       | Cron-style automation jobs.                                              |
| `datastore.*`                                                                                            | Project-scoped tabular database (tables/rows), separate from `store`.    |
| `datasource.getSources/.getDomains/.learn`                                                               | Training data source management.                                         |
| `browser.run(mission, opts?)`                                                                            | Trigger a full AI Browser mission (multi-step, self-correcting, slower). |
| `causality.think(query, opts?)` / `.absorb(causalities, opts?)`                                          | Deep causal reasoning over accumulated context, and feeding new causal facts back in. |
| `attachment.search/.deepResearch/.evaluate/.queryTabularData/.queryMediaTimestamp`                        | Attachment analysis helpers.                                             |

## Top-level shorthands

Imported the same way as the namespaces: `import { ask, hil, a2a, log, wait, config } from '@aivin-labs/sdk'`.

| Method                               | Description                                              |
| ------------------------------------ | -------------------------------------------------------- |
| `ask(question, schema?)`     | Ask the human user a question, block until answered (or timeout). |
| `hil(key, prompt, options?)` | Human-in-the-loop review gate with selectable options + optional free text. |
| `a2a(target, data, purpose)` | Same as `agent.delegate`.                                |
| `log(msg, level?)`           | Structured log line.                                     |
| `wait(ms)`                   | Sleep without blocking the event loop.                   |
| `config()`                   | This plugin's saved workspace config (read-only; also available as `ctx.config`). |

## What's in `ctx`

```typescript
export async function main(mission: string, input: PluginInput, ctx: PluginContext) {
  ctx.user; // who triggered this run
  ctx.workspace; // current workspace
  ctx.session; // current chat/automation session, if any
  ctx.cert; // connected-account credentials, if manifest.connection_id is set
  ctx.sdk; // legacy handle to the same client - prefer the imports (see Calling the SDK)
  // `mission` (1st arg) is the human-readable reason this run was triggered — for logging, not routing.
}
```

## Response size limit

Whatever `main()` returns is capped at **1MB** once JSON-serialized; larger responses are
truncated by the host. Keep return payloads to what the caller actually needs — page/paginate
large result sets instead of returning everything at once.
