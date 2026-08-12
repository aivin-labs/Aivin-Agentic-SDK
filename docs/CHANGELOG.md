# Changelog

## Unreleased

### 🆕 Added — `agent.runFlow()` and `ContextBuilder`

Plugins can now run a flow (CONDITION/ROUTER/PARALLEL/RETRY/WAIT/LOOP/ACTION steps) directly from
code — the same engine a published `workflow`-type plugin and `automation.createJob`'s `workflow`
field already run on (`FlowService.runFlow` + `WorkflowPluginService.buildStages`, backend), now
reachable without first publishing/scheduling anything. `flow` accepts either a `WorkflowGraph`
(`{ nodes, edges }`, the exact JSON the platform's Workflow Editor exports) or an already-built
`FlowStage[]`. New `ContextBuilder(...)` helper (top-level export) builds the flow's explicit
identity — which agent/workspace it runs as, and optionally an existing `session_id` to attach to
instead of a new hidden session. See [`docs/sdk/agent.md#runflow`](./sdk/agent.md#runflow).

Also added `agent.promptAgentic()`/`agent.promptAction()`/`agent.promptAssistant()` — force one of
the 3 modes `agent.processMessage`'s NLU classification step would otherwise pick between
(multi-step planner / single-plugin direct execution / plain conversational reply), for callers
that already know which mode a given turn needs. Each keeps its own backend fallback chain
(agentic→assistant, action→assistant/agentic) — only the initial mode choice is forced. See
[`docs/sdk/agent.md#forcing-a-mode`](./sdk/agent.md#forcing-a-mode-promptagentic--promptaction--promptassistant).

### 🐛 Fixed — `notification.push()` silently delivered nothing and dropped message text

Verified field-by-field against the real backend handler chain
(`NotificationSDK.ts` → `NotificationService.pushNotification` → `NotificationRequest` DTO → each
engine's `render()`/`process()`) and found two field-name mismatches that both round-tripped without
throwing, so neither was ever caught by a test that only checks "did the call succeed":

1. **Audience**: the backend resolves recipients from `user` (full object) / `receiver_id` /
   `receiver_ids` / `topic` — it never reads `user_id`. A bare `{ user_id, title, body }` call
   resolved to an empty audience and `pushNotification`'s try/catch swallowed the resulting no-op.
2. **Content**: every engine reads `notiReq.message`, never `notiReq.body` — a bare `body` was
   silently dropped in favor of an AI-generated (`prompt`) or generic fallback message instead of
   the caller's text.

`push()` still accepts `user_id`/`body` (kept for API familiarity) but now remaps them to
`receiver_id`/`message` before the call leaves the client, via a new `pushNotificationParamsSchema`
(`validation.ts`) that also requires at least one real audience field (`user_id`/`receiver_id`/
`receiver_ids`/`topic`) locally, so a missing/mistyped recipient fails immediately instead of
vanishing silently.

### 🆕 Added — typed `channels`/`priority`/`receiver_ids`/`topic`/`prompt`/`title_key`/`message_key`/`vars`/`messageIsHtml` on `notification.push()`

The backend's `NotificationService.pushNotification` pipeline already supported multi-channel
dispatch, priority-based engine routing, batch/topic-broadcast audience resolution, i18n rendering,
and AI-generated content from a `prompt` — none of it was typed or documented on the SDK side, only
reachable through the untyped `[key: string]: any` escape hatch. See
[`docs/sdk/notification.md`](./sdk/notification.md) for the full field reference and examples.

## [1.0.4] - 2026-08-10

### 🔧 Changed — `datastore` renamed to `table`; `pluginStore` renamed to `plugin`

`export const datastore = bindNamespace('datastore')` (`globalSdk.ts`) never matched the real wire
namespace the backend registers under (`PluginBridge.sdkFunction('table.*', ...)` in
`DatastoreSDK.ts`, and the legacy `ctx.sdk` facade's own `get table()` in BE's `src/base/SDK.ts`) -
`SDKClient.readonly datastore` and every `validateParams(..., 'datastore.X')` call site are now
`table`/`'table.X'` to match. `import { datastore } from '@aivin-labs/sdk'` no longer resolves to
anything - use `import { table } from '@aivin-labs/sdk'`. Same rename for the internal
`@internal`-only `pluginStore` → `plugin` (aivin-service's marketplace catalog access, stripped
from the published `.d.ts`; not part of the public plugin-author surface).

### 📝 Fixed — docs/CLI-prompt catching up to the `table` rename

The rename above landed in code but not in the docs that shipped in the same release: `README.md`'s
namespace table, `docs/SDK.md`'s "Persistent storage" section, and the dedicated
`docs/sdk/datastore.md` page (renamed to [`docs/sdk/table.md`](./sdk/table.md)) all still said
`datastore`; `docs/sdk/project.md` still cross-referenced it by the old name. Most consequential:
`bin/cli.mjs`'s AI-codegen system prompt (what `aivin create`/`aivin init` feed the LLM to write new
plugins) listed `datastore` as an available namespace - any generated plugin calling it would have
hit an `undefined` import at runtime. That same namespace list was also missing `project` and
`code` entirely (both real, existing namespaces) - added.

## [1.0.3] - 2026-08-10

### 🆕 Added — typed sugar for `pluginStore.findDocsBySourceRepo`/`pluginStore.patchByIds`

`check-contract.mjs --be-path` flagged the new `pluginStore.*` namespace (BE's plugin-marketplace
catalog, added same day) as 18 registrations reachable only via the untyped `call()` escape hatch.
Added sugar for the 2 actually consumed in production right now — `aivin-service`'s `AivinBackend.ts`
(the *sole* way that repo's `MarketplaceBackend` implementation reads/writes BE's catalog, now that
its old direct-OpenAI/Anthropic "standalone" path has been removed entirely). The other ~14
`pluginStore.*` registrations (`getPlugin`, `searchPlugins`, `upsertPlugins`, ...) stay
escape-hatch-only — no current caller reaches for them, so no sugar added speculatively.

Marked `pluginStore` `@internal` + enabled `stripInternal` in `tsconfig.json` — it's rejected
server-side for any caller besides aivin-service (`PluginStoreSDK.ts::assertMarketplaceCaller`), so
it had no business appearing in a plugin author's Monaco autocomplete. Confirmed the published
`.d.ts` now omits it entirely while the compiled runtime JS still has it (aivin-service compiles
against this same source, unaffected).

### 🐛 Fixed — `withTrace` was never re-exported from the top-level package entry

`export { getCurrentTrace, formatTraceForConsole } from './sdk/trace'` (`src/index.ts`) always
skipped `withTrace` itself — the function BE's own `bootstrapper.js` (native/PROMOTED_CODE plugin
runtime) needs to give that runtime the same per-call `sdk.*` trace visibility Docker-runtime
plugins already get for free via `PluginServer.ts`'s own `withTrace` usage. `require('@aivin-labs/sdk').withTrace`
silently resolved to `undefined` (destructuring doesn't throw) — the crash only happened later, at
the point `withTrace(...)` was actually *called*, past where any `try/catch` around the `require`
would catch it. Added to `src/index.ts`'s export list; verified against the built `dist/index.js`
that it now resolves to a real function.

## [1.0.2] - 2026-08-10

> `package.json` had drifted out of sync with this file for a while (see the note above `[1.2.0]`
> below) — everything documented under `[1.1.0]` and `[1.2.0]` was written and merged but never
> `npm publish`'d under those version numbers. This release is the first real publish since
> `1.0.1` and carries all of that plus the breaking change below.

### ⚠️ Breaking — renamed `SDK_GRPC_ENDPOINT`/`SDK_GRPC_SECRET` to `SDK_ENDPOINT`/`SDK_SECRET`

Transport (gRPC) is an implementation detail, not something plugin authors should need to know to
set the right env var. Old names no longer read — update your `.env`/deployment config.

### 🆕 Added — typed sugar for the last 3 backend routes only reachable via `call()`

`check-contract.mjs` flagged 3 real backend registrations with no `SDKClient.ts` wrapper. Added
`knowledge.get(knowledgeIds)`/`knowledge.del(ids)` (confirmed against `BrainSDK.ts`'s
`knowledge.batchGetKnowledge`/`knowledge.batchDeleteKnowledge` handlers - previously documented as
"no confirmed real implementation", which was stale) and `redis.decr`/`redis.decrby` (mirrors
`incr`/`incrby`, confirmed against `PluginStorageService.redisDecr`). `check-contract.mjs` now
reports 0 dead calls and 0 missing-sugar entries against the real backend.

> ⚠️ **Note added retroactively**: the `[1.1.0]` and `[1.2.0]` sections below were written when
> `package.json`'s version field still matched, but a later commit reverted the version field back
> to `1.0.1` without reverting the changelog — so neither `1.1.0` nor `1.2.0` was ever actually
> published to npm. Everything below is real and shipped, just under the `1.0.2` tag above instead.

## [1.2.0] - 2026-07-29

### 🆕 Reworked — `aivin plugin convert` into an agentic, tool-relay-based conversion pipeline

Previously a single `/code/generate` call with the whole project dumped in as `workspace_files` -
didn't scale to a large project (uploads everything up front) and could only ever write one
`src/main.ts`. Now a real multi-step loop, orchestrated server-side and driven by a new
`POST /code/convert-project` endpoint:

- **Scan on demand, not upload up front**: the CLI sends only the directory tree (paths + byte
  sizes, never content); the server decides which files are actually worth reading and asks the CLI
  to read them back one at a time over the same socket connection `aivin plugin logs` already uses
  (`code:tool_call`/`code:tool_result`, relayed through a new `CodeToolRelay` service). Bounded to 5
  scan rounds, 4 files/round.
- **Plans before generating**: detects the project's shape (plain script, MCP server, API backend,
  Claude-style skill) and decides single-file vs. a multi-file/multi-function plan, `create` vs.
  `update` per file - including a dedicated **cross-language port mode**: a non-TypeScript source
  project (Python, Go, ...) gets every file forced to `action=create` (there's no existing `.ts` to
  edit in place) with an explicit instruction to faithfully translate the real logic, not guess at
  it, and flag anything with no clear TypeScript/npm equivalent.
- **Generates in dependency "waves"**, not one file at a time - files with no `depends_on` on each
  other run concurrently (through the same adaptive, resource-aware concurrency engine other heavy
  work in the platform already uses, not an unbounded `Promise.all`).
- **Never overwrites an existing file silently**: warns up front if the directory has uncommitted
  git changes, then prompts per-file before actually overwriting anything already on disk (skips
  just that one file if declined, or if the prompt times out - never aborts the whole run over a
  slow answer).
- **Verifies before calling it done**: a real `tsc --noEmit` run (now `--incremental`, so a
  multi-round fix loop on a large project isn't a full cold recompile every time), a static check
  that the plan's promised exports actually exist in the generated entry file, and a sandboxed smoke
  test (spawns the real plugin runtime locally with AI-generated sample input) - each with one bounded
  self-correction attempt before giving up and reporting what's still wrong.
- `--force` re-runs the whole loop against a project this command already converted before, instead
  of refusing outright because `src/main.ts` exists.

See [CLI.md#aivin-plugin-convert-hint](./CLI.md#aivin-plugin-convert-hint) for the full walkthrough.

### 🆕 Added — complexity-adaptive `aivin plugin make`/`aivin init`

`aivin plugin make` now calls a new `POST /code/generate-project` endpoint that classifies the
requirement first: simple/moderate requests still cost exactly one generation call and write exactly
`src/main.ts`, unchanged from before; a genuinely complex requirement (several independent
capabilities, or logic too large for one flat function) gets planned into a small multi-file project
and, when warranted, a [multi-function manifest](./MANIFEST.md#multi-function-plugins) - the same
planning/wave-generation/self-correction machinery `plugin convert` uses, just starting from a
description instead of an existing project. Previously every request, however complex, was crammed
into one `main()` with no escape hatch.

### 📝 Improved — self-correction loop now windows large files instead of resending them whole

Fixing a compiler error in a file that runs into the hundreds/thousands of lines used to resend the
entire file on every fix attempt, with no line numbers for the AI to reliably match against tsc's
own `file(line,col)` output. Now builds a small numbered window around just the reported error
line(s), asks for a fix scoped to that window, and splices the result back in place - cheaper and
more precise on large files, whole-file fix remains the fallback when no line number can be
extracted at all.

## [1.1.0] - 2026-07-28

### 📝 Documented — `manifest.json`'s `avatar` field

Real, working, already-persisted on every deploy (`PluginModel.ts`'s schema has had `avatar: String`
all along, and `PluginStoreService.loadPlugin` spreads the whole manifest object into it) - but was
typed on neither side (`PluginTypes.ts` here nor the backend's own `PluginDTO.ts`) and never
mentioned in `docs/MANIFEST.md`, so no plugin author had a way to discover it existed. Added
`avatar?: string` to `PluginManifest` and a field-table row explaining it's a URL (host the image
via `resource.upload` or elsewhere first, not raw bytes) with a fallback to the publishing user's
own avatar when omitted.

### 🆕 Added — real unit-testing utilities (`createMockSDK`/`withMockSDK`/`createMockContext`) + live debug streaming

Previously the only way to exercise a plugin's logic was a real `aivin start` + curl round trip
(or the heavier `PluginServer.testInvoke`) - no way to unit-test `main()`/`service.ts` against a
fake SDK. New top-level exports:

- `createMockSDK({ identity?, handlers? })` - fake `SDKClient`, one handler function per
  `namespace.method`; calling anything unmocked throws immediately naming the missing one (loud
  failure at the call site, not a silent `undefined`). Returns `{ client, calls }` for asserting on
  what was actually sent.
- `withMockSDK(client, fn)` - binds the mock as the ambient client so the *recommended*
  `import { ai } from '@aivin-labs/sdk'` top-level style resolves to it too, not just `ctx.sdk`.
- `createMockContext(client, overrides?)` - builds a `PluginContext` around a mock client with
  plausible `user`/`workspace` defaults.

`aivin create`/`aivin init` now scaffold a real, runnable `test/main.test.ts` (or
`test/service.test.ts`) using these, plus a `test` script in the generated `package.json` (Node's
own `--test` + native TS execution - no new tooling). Verified end-to-end: scaffolded a fresh
project with the updated CLI and ran its generated test for real - passes against the actual
generated `src/main.ts`, not just type-checks.

Also added live per-call debugging: `SDK_DEBUG=json` (new, alongside the existing
`SDK_DEBUG=true` human-readable mode) prints one JSON object per `sdk.*` call as it happens - for a
script or coding agent reading the process's stdout to parse programmatically, instead of a
post-hoc trace summary or pattern-matching free text. `aivin start --debug` / `--debug-json` are
CLI sugar for the two modes. See [CLI.md#aivin-start](./CLI.md#aivin-start) and
[SDK.md#testing](./SDK.md#testing).

### 📝 Improved — `AGENTS.md` scaffold: testing + debugging sections

The scaffolded `AGENTS.md` (read automatically by Claude Code/Cursor/other coding agents opening a
plugin project) now has "Commands you'll actually use" pointing at `npm test`/`--debug`/`--debug-json`,
and a "Debugging a failure" section with a concrete repro-and-inspect flow - written for an agent
working autonomously in the directory, not just a human skimming a README once.

### 🆕 Added — `agent.reply(quest, opts?)` and `agent.tell(text)`

New chat-streaming primitives on `agent`, not `ai`: previously the only way to stream text into the
current chat as a real, persisted message was internal to the platform's own agent orchestration
code (`AIEngine.prompt(quest, opts, { ctx, listener })` built from `MessageService`) — not reachable
from plugin code at all. `agent.reply` exposes that mechanism directly (LLM call + stream into
chat); `agent.tell` is its no-LLM sibling for text you already have (pure passthrough, animated with
the same word-by-word typing effect). Both fall back gracefully (`agent.reply` to a plain
non-streamed `ai.prompt`; `agent.tell` to `{ success: false }`) when the invocation has no live chat
session (automation/webhook/API context) — safe to call unconditionally.

`agent.reply`'s `opts.rich_content: true` unlocks the model rendering *passive* rich components
(table/chart/mermaid/media/cardview/webview/citation) — deliberately never selection/form/action,
since those need `agent.hil()`'s suspend+lock+routing plumbing to receive a response when clicked;
enabling them via `reply`/`tell` would render a button that looks interactive but silently does
nothing. See [sdk/agent.md](./sdk/agent.md#rich-components-and-hil) for the full explanation.

Both share a per-session rate limit (backend, default 20 pushes/60s, configurable via
`sandbox.agent_chat_push_rate_limit`) — neither call has a cost gate that would otherwise stop a
buggy/looping plugin from flooding a user's chat with unlimited persisted messages.

### 🐛 Fixed — `code` namespace unreachable via the documented top-level import

`SDKClient.ts` and `docs/sdk/code.md` both already assumed `import { code } from '@aivin-labs/sdk'`
worked, but `globalSdk.ts` never actually exported it — only the legacy `ctx.sdk.code.executeLogic(...)`
path worked. Added the missing `export const code = bindNamespace('code')`.

### 🆕 Added — local zod validation extended to `store.*` and `datastore.*`

Same treatment as `automation`/`resource` below, extended to the two highest-traffic write
namespaces. Both were verified field-by-field against the real `StoreSDK.ts`/`DatastoreSDK.ts`
first — unlike `automation`, these were already shape-correct, so this is a pure runtime-guard
addition, not a bug fix. Also wired `scripts/check-contract.mjs` into CI (`.github/workflows/ci.yml`,
`check-contract` job) — currently a documented no-op until `vars.BE_REPO`/`secrets.BE_REPO_TOKEN`
are configured, since the checker needs a checkout of the separate backend repo.

### 🆕 Added — local zod validation for `automation.*` and `resource.upload`/`.remove`

Following up on the `automation`/`resource` fixes below with a structural guard, not just a one-time
correction: `automation.createJob`/`.updateJob`/`.getJobs`/`.deleteJob`/`.executeById` and
`resource.upload`/`.remove` now validate `params` against a zod schema (`src/sdk/validation.ts`)
*before* the call reaches the network. A wrong shape throws immediately with a clear
`[namespace.method] invalid params - field: reason` message instead of silently sending a request
the backend partially (or entirely) ignores — this is precisely the failure mode that let the old
`{ name, schedule, logic }` shape below ship undetected. New dependency: `zod` (already a de facto
standard, ~small footprint; this package was never actually "dependency-free" - see `axios`,
`socket.io-client`, `inquirer` already in `dependencies`). Covers only these two namespaces for
now — extend the same way (verify every field against the real backend handler first) rather than
schema-ifying everything speculatively.

### 🛠️ Added — `scripts/check-contract.mjs`, a BE↔SDK namespace drift checker

A best-effort static scanner (`npm run check:contract -- --be-path <path-to-be-repo>`) that
cross-references every `this.call('namespace.method', ...)` in `SDKClient.ts` against every real
`PluginBridge.sdkFunction`/`.sdkMethods`/`.sdkStreamFunction` registration in the backend repo, and
reports namespace/method names that exist on only one side. Catches the "SDKClient.ts calls
something the backend doesn't register" class of bug going forward (a `namespace.method` STRING
existing on both sides) — it does **not** check param shapes, so it would not have caught the
`automation.createJob` field-name bug on its own; the zod schemas above are the shape-level guard.
Not wired into CI yet (needs a checkout of the backend repo to run against); run it manually after
any change to `SDKClient.ts` or when the backend's `PluginBridge` registrations change.

### 📝 Improved — storage namespace guidance (`store`/`datastore`/`mongo`/`redis`)

The four persistence namespaces serve genuinely different purposes, not four ways to do the same
thing — but the docs never said so in one place before, leaving "which one do I use" to be
reverse-engineered from four separate pages. Added a real decision guide (README and
[SDK.md](./SDK.md#persistent-storage--store-datastore-mongo-redis)): `datastore` for user-facing
tables the platform UI renders, `store` as the default for everything else, `mongo`/`redis` only
for their specific niches (porting Mongo-shaped logic; ephemeral cache/counters).

### 🐛 Fixed — `automation.createJob`/`.updateJob`/`.getJobs` had fictional param names

A previous audit pass typed these against a guessed-at generic "cron job" shape
(`{ name, schedule, logic }`) that never matched the real backend and was never actually verified
against it — the real `JobRequest`/`JobListRequest` (`AutomationDTO.ts`) use `mission`/`prompt`
(what the job does — there is no `logic`/code-string field at all) and `schedule_condition` (a
natural-language description the backend parses itself, not a raw cron string). Using the old
documented shape would silently create a job with the wrong mission/schedule (or, for `agent_id`,
fail loudly — that field was already accidentally correct-shaped but wasn't documented as required).
Fixed `SDKClient.ts`'s `automation` namespace, added a real `AutomationJob` type (was `any`/`any[]`
throughout), and rewrote [sdk/automation.md](./sdk/automation.md) end to end. Also documents the
server-side rate limit (10 calls/5min, shared between `createJob` and mission/schedule-changing
`updateJob` calls) that wasn't mentioned anywhere before.

### 🆕 Resolved — `resource.upload`'s previously-hedged uncertainties

`docs/sdk/resource.md` had several "presumably"/"not confirmed" hedges around `file`'s accepted
shape and `is_public`/`temp`'s actual effect. Traced through the backend's real `toBuffer()`
normalizer and `FSIO.ts` and resolved all of them: `file` accepts exactly a base64 string, a
`{type:'Buffer',data:number[]}` object, or a `number[]` (a raw `Buffer` does not survive the JSON
round-trip on its own); `temp`/`is_public` behave as guessed. Added a real `ResourceMeta` return
type (was `Promise<any>`) and an undocumented `workspace_id` param.

### 🆕 Resolved — `session.newSession` vs `session.create`'s actual relationship

`docs/sdk/session.md` previously said the difference between these two was unverified. Traced
through the backend's real `SessionService`: `create()` is the higher-level call (auto-resolves a
default workspace, builds a full session record via `buildSessionDTO`) which internally calls
`newSession()` — the lower-level primitive, which is idempotent by `id` (touches `last_updated` and
returns the existing record rather than duplicating if that `id` already has a session). Documented
when to reach for each.

### 🐛 Fixed — `TriggerType` missing `widget`

`types/PluginTypes.ts`'s `TriggerType` const had 6 of the backend's 7 real values, missing `widget` —
meant a plugin authored in TypeScript couldn't type-safely declare `trigger_type: [TriggerType.WIDGET]`
even though `'widget'` is a real, host-enforced value (hides a plugin from every non-widget session;
see [MANIFEST.md#trigger-types](./MANIFEST.md#trigger-types)).

### 🆕 Added — `browser.cancel(sessionId?)`

Requests cooperative cancellation of a running AI Browser mission (backend checks for it between
agentic-loop steps — can't interrupt a step already in flight). Always targets the calling tenant's
own mission; `sessionId` is accepted only as a self-check against that same tenant, never a way to
cancel another tenant's mission (see security fix below). `browser.run()`'s result now also carries
`data.session_id` so it can be passed back later. See [sdk/browser.md](./sdk/browser.md).

### 🔒 Fixed — cross-tenant `browser.cancel` DoS + SSRF blocklist gaps (backend, `be` repo)

Backend-side hardening alongside the new `browser.cancel`:

- `browser.cancel`'s first draft trusted a caller-supplied `session_id` outright — any tenant could
  cancel another tenant's running mission. Fixed to always resolve the tenant from the caller's own
  context; `session_id` is now rejected unless it matches that tenant.
- `AIBrowserService`'s SSRF hostname blocklist missed IPv4-mapped IPv6 (`::ffff:127.0.0.1`), the
  `fd00::/8` half of the IPv6 ULA range, and CGNAT `100.64.0.0/10` (which covers Alibaba Cloud's
  metadata IP). Rewrote it to parse real IP bytes (`net.isIP`) instead of matching hostname strings.
- Added a DNS-rebinding backstop: `setupAdvancedPage` now checks each response's actual
  `remoteAddress()` (the IP really connected to, not a separately-resolved one) and aborts the
  mission if it lands on a private/internal address — closes the TOCTOU window a hostname-only
  check can't.

### 🆕 Added — SDK surface audit: wired up backend RPCs that had no client-side sugar

Cross-checked every `PluginBridge.sdkFunction`/`sdkMethods` registration on the backend against
`SDKClient.ts`'s sugar objects and added the ones that were missing (previously only reachable via
the generic `call('namespace.method', ...)` escape hatch):

- `ai`: `tts`, `stt`, `getModels`, `calculateTokens`
- `knowledge`: `store`, `reinforce`
- `causality`: `search` (backed by `think.search`)
- `workspace`: `updatePlugin`
- `agent`: `processMessage`, `resolveHil`
- `attachment`: `upload`, and a new `extract` method (raw extracted chunks of an attachment, no AI
  summarization — reads back what the backend's extract-engine already produced during `upload`)
- `datastore`: `rollback`, `getAllTables`, `getTableStats`, `countRows`, `exportTable`,
  `deduplicateTable`, `backfillColumn`, `formatRowsForContext` (previously only reachable via the
  HTTP/UI route, not the SDK)
- `task`: `gen`, `addComment`, `requestSupport`
- `message`: `init`, `stream`
- `session`: `updateAgent`
- New top-level `getCachedUser(id)` (Redis-cached variant of `user(id)`)
- New `code` namespace: `executeLogic`

`storage.*`/`queue.scheduleJob`/`realtime.publish` were initially suspected dead (no
`PluginBridge.sdkFunction` registration found) but turned out to be registered via the separate
`PluginBridge.sdkMethods(...)` bulk-bind helper in `PluginStorageService.ts` — confirmed working,
no changes needed there.

## [1.0.1] - 2026-07-27

Everything below happened after `1.0.0` was already published to npm - fixes/features here ship in
`1.0.1`.

### 🆕 Added — `aivin init [name]`, a guided one-command alternative to `create` + `plugin make`

Asks what the plugin should do, then scaffolds the project **and** generates real working code
from that description in one step - instead of `aivin create` followed by a separate
`aivin plugin make`. Splits the result into two files instead of one:

- **`src/service.ts`** - the actual business logic, AI-generated. A single exported
  `execute(input, ctx)` returning plain result data (or throwing a plain `Error`) - no
  `PluginResponse`/`PluginStatus` envelope to think about.
- **`src/main.ts`** - a thin, static wrapper (not AI-generated, never changes) that calls
  `execute()` and packages the result into the `PluginResponse` the platform expects. This
  filename is fixed - the runtime always loads exactly `src/main.ts` - `service.ts` is just this
  project's own convention for where the logic lives, not a platform requirement.

Achieved without any backend code-generation changes: the existing `/code/generate` endpoint
already branches its prompt based on `target_file` (a "MAIN ENTRY POINT, must return
PluginResponse" branch for `src/main.ts`, a generic "utility file" branch for anything else) -
`aivin init` targets `src/service.ts` (the generic branch) for the AI-generated part, and writes
`src/main.ts` itself, deterministically, client-side.

`aivin plugin make` now detects an existing `src/service.ts` and regenerates that instead of
`src/main.ts`, so re-running it on an `aivin init`-created project doesn't silently collapse the
split back into one file. Falls back to the plain placeholder handler (same as `aivin create`) if
generation fails, so a network hiccup never leaves a half-scaffolded project. `AGENTS.md`
scaffolding (see below) also adapts its content depending on which layout a given project has.

Verified live end-to-end: real code generation, correct runtime output, clean `tsc` compile of the
two-file split together.

### 🔄 Changed — `aivin validate` defaults to the current directory's `manifest.json`

Previously required `--json <config>` or `--stdin` even for the common case (validating your own
project) - `aivin validate` now just works from inside a plugin directory. `--json`/`--stdin`
remain for scripted/CI use where the config isn't a file on disk yet.

### 🐛 Fixed — plugin-to-plugin calls (`ctx.sdk.call('other_plugin_id', params)`) never actually worked

The AI code generator's own instructions (`CodeGenerationHelper.ts` on the backend) told every
generated plugin to reuse an existing plugin via `ctx.sdk.call('plugin_id', params)` when one
matched the task. This was false for this SDK's Docker/gRPC runtime: the inbound dispatcher
(`GrpcSDKServer.Invoke` → `PluginBridge.call()`) only ever looked up registered host methods
(`ai.*`, `agent.*`, `datastore.*`, ...) and threw `SDK_FUNCTION_NOT_FOUND` for anything else - the
plugin-to-plugin fallback (`PluginBridge.trigger()`) existed on the backend but was only wired into
`InProcessTransportAdapter`, a different (LITE/in-process) plugin runtime. Any AI-generated plugin
that followed the platform's own advice and called another plugin would crash at runtime. Fixed by
adding the same fallback to `PluginBridge.call()` - verified live that the failure mode changed
from `SDK_FUNCTION_NOT_FOUND` to a (correctly) deeper-stage error once the target is an actual
Docker-runtime plugin, which this sandbox's bare-metal backend can't fully reach for the same
Docker-networking reason noted above.

### 🆕 Added — `aivin plugin search <query>`

Search the platform's plugin ecosystem before writing new logic - wraps the backend's existing
`GET /plugins/search` (the same relevance-ranked lookup the platform's own agent uses to
auto-select a plugin for a mission; newly opened up to API-key auth via `@AllowApiKey()` so the CLI
can reach it, not just a browser session). `--workspace <id>` narrows scope, `--limit <n>` caps
results. Verified live - found a real previously-deployed plugin by name.

### 🆕 Added — `AGENTS.md` scaffolding + `import` style as the documented default over `ctx.sdk`

- `aivin create` now writes a short `AGENTS.md` into every new plugin project - the emerging
  cross-tool convention (Claude Code, Cursor, and others read it automatically on open). Unlike
  `docs/AI-Plugin-Guide.md` in *this* repo, a coding agent working inside a freshly-scaffolded
  plugin project (a different directory entirely) had no way to discover that guide on its own.
  Covers: the two files that matter, the preferred `import { ai } from '@aivin-labs/sdk'` style vs.
  when to actually reach for `ctx.sdk`, `aivin plugin search` for reuse-before-rewrite, and the
  handful of CLI commands you'll actually run day to day.
- `docs/SDK.md` and the backend's own AI code-generation instructions/template
  (`CodeGenerationHelper.ts`) now both lead with the top-level `import` style as the default,
  explaining `ctx.sdk` exists specifically (and only) for code that isn't guaranteed to run inside
  `main()`'s async context - not as a beginner-friendly alternative. Verified live: a fresh
  `aivin plugin make` generation now produces `import { ai } from '@aivin-labs/sdk'` code instead of
  `ctx.sdk.ai.prompt(...)`.
- Added `AGENTS.md` at this repo's own root too, for anyone (human or agent) working on the SDK's
  source directly - distinct from the one scaffolded into consumer projects.

### 🐛 Fixed — real end-to-end Docker test uncovered 2 deployment-blocking backend bugs

Set up a genuinely fresh project (`aivin create`, real `npm install` from the public registry now
that `@aivin-labs/sdk` is published) and deployed it for real - built Docker image, ran the
container, invoked it - to verify the whole chain actually works, not just the SDK in isolation.
Found and fixed two real bugs on the backend (`c:\Project\be`), both severe enough to block
*every* freshly-scaffolded plugin, not just this test:

1. **The AI security scan didn't know the platform's own SDK is first-party.** A completely
   unmodified `aivin create` scaffold got blocked at deploy with `"@aivin-labs/sdk": "Unknown
   third-party dependency may contain malicious code"` and `"aivin start": "could execute arbitrary
   operations"` - the scanner had zero awareness that these are the platform's own required
   conventions, not arbitrary third-party code. Fixed in `CodeSecurityHelper.ts`: added a
   `KNOWN_SAFE_PLATFORM_CONVENTIONS` block, and - prompted by a sharp catch mid-review - restructured
   the whole call so the task instructions go through `AIEngine.prompt()`'s `instructions` option
   (trusted, system-level) instead of being concatenated into the same string as the file content
   being analyzed (untrusted, now relies on `AIEngine`'s existing `<user_input>` auto-wrapping for a
   real instruction/data boundary - the old concatenated-string version had no such boundary, an
   actual prompt-injection gap a malicious plugin's code could have exploited to talk its way past
   the scanner).
2. **`aivin create`'s own scaffold pinned dependencies to `"latest"`**, which is exactly the
   anti-pattern the security scanner (correctly) flags as a supply-chain risk - a second,
   independent way every fresh scaffold was guaranteed to fail its own platform's deploy check.
   Now pins `@aivin-labs/sdk` to an exact version and `typescript`/`@types/node` to `^` ranges
   instead of `latest`.

Also fixed: `aivin login --basic`'s default `--client` was `"aivin.vn"`, inconsistent with the
platform's real default domain `aivin.cloud`.

With both backend fixes in place, verified a full real cycle end to end: `aivin create` →
`npm install` (real registry) → `aivin test` → AI security scan passes → Docker image builds →
container starts and runs the real published SDK's `aivin start` (previously impossible to verify
in a sandbox with no registry access - see the `aivin plugin make` self-heal fix below, from
*before* this SDK was published). The final hop - the backend process actually invoking the running
container over gRPC - could not be verified in this specific sandbox: plugin containers get their
own isolated Docker network per deployment, and the backend here runs bare-metal (not itself
containerized on that network), so it can't reach the container's IP or resolve its Docker-internal
DNS name. This is a property of how this sandbox runs the backend for testing, not a code defect -
production backend deployments run containerized on the shared Docker network stack, per the
already-running `aivin-be` service confirmed alongside this test.

### 🐛 Fixed — `aivin create --json`/`--stdin` never told you to `cd` into the new project

Found during a post-publish DX audit: `createFromJSON()` (the non-interactive/scripted path behind
both `--json` and `--stdin`) always creates the plugin in a **subdirectory** named after
`config.name`, but its "Next steps" output only ever printed `npm install` / `npm start` - never
`cd <name>` first. Following the printed instructions verbatim ran `npm install` in the *parent*
directory. The plain interactive `aivin create <name>` path already had this right (fixed earlier
this session) - this fix brings the scripted path to parity.

## [1.0.0] - 2026-07-27

First published release (`npm install @aivin-labs/sdk`).

### 🆕 Added — `sdk.ai.promptStream()`, true token-level AI streaming

- New `ctx.sdk.ai.promptStream(quest, opts)` - same ergonomic shape as Vercel AI SDK's
  `streamText()`: returns `{ textStream, text }` where `textStream` is an `AsyncIterable<string>`
  of deltas as the model generates them, and `text` is a `Promise<string>` resolving to the full
  response once the stream ends. `text` resolves correctly even if `textStream` is never iterated.
- Required a new server-streaming RPC end to end: `InvokeStream` added to
  `sdk_transport.proto` (kept in sync with the backend's copy at
  `src/base/sdk/proto/sdk_transport.proto`); backend registers `ai.promptStream` as a
  streaming-capable route (`PluginBridge.sdkStreamFunction`) that forwards `AIEngine.prompt`'s
  existing driver-level `onUpdate` chunks straight through to the plugin, instead of buffering the
  whole response server-side first like `ai.prompt` does. `GrpcSDKServer.InvokeStream` shares the
  exact same auth/capability-resolution path as `Invoke` (extracted to
  `authenticateAndResolveContext`, not duplicated) so the two RPCs can't drift apart on tenant
  isolation.
- Verified live end-to-end against a real backend: 9 real token chunks streamed in for a live LLM
  call, concatenated chunks matched the final aggregated text exactly.
- Fixed a real crash found while verifying this: a rejected `final` promise that nobody
  `await`ed/`.catch()`'d (e.g. a caller that only consumes `textStream`) was an unhandled promise
  rejection that took down the whole plugin process on modern Node. `invokeHostStream` now attaches
  a swallow-only handler internally so this can't happen, without affecting real callers who do
  await/catch `final` normally.
- No automatic retry for streaming calls (unlike `invokeHost`) - a stream can be partway through
  delivering chunks when a transport error happens, and there's no safe way to resume or re-run a
  partially-observed stream without risking duplicated/interleaved output.

### 🆕 Added — per-invocation execution trace (`aivin start`/`aivin test` dev tooling)

- Every plugin invocation now collects a structured trace of every `ctx.sdk.*`/global-import call
  made during it (namespace, duration, retry attempts, success/error), isolated per-invocation via
  `AsyncLocalStorage` the same way the active `SDKClient` already is - concurrent invocations in the
  same process never cross-contaminate each other's trace.
- `PluginServer` prints a readable timeline to the console after every invocation (success or
  failure) by default - set `AIVIN_TRACE=false` to opt out. `AIVIN_TRACE_PUBLISH=true` additionally
  best-effort publishes the trace via `realtime.publish('plugin.trace', ...)` so the host can
  eventually surface it in the platform's own execution-flow UI (same shape family as the agent
  flow view's stage/mission timelines), off by default since not every deployment has that consumer
  wired up and every publish is a billable call the plugin didn't ask for.
- New exports: `getCurrentTrace()` (usable from inside `main()` itself), `formatTraceForConsole()`,
  types `InvocationTrace`/`TraceEvent`.
- Verified live via `aivin start` + curl - trace prints correctly for both zero-call and
  multi-call invocations.

### 🔄 Changed — structured-output self-healing (LangChain `OutputFixingParser`-style)

- When a caller passes `schema` to `AIEngine.prompt()` and the model's response can't be parsed
  into valid JSON (the driver-level `repairAndParseJSON` already tries `jsonrepair` + regex
  extraction, then falls back to returning the raw string), the engine now makes **one** corrective
  follow-up call before giving up: sends the malformed output + the schema back to the same model
  and asks for a corrected JSON-only response. Bounded to one attempt (`_isSelfHealAttempt` flag)
  to avoid infinite recursion if the model keeps failing to format correctly; falls back to the
  original raw-string behavior (unchanged) if the correction attempt also fails.
- Motivated directly by a real bug fixed earlier this session: the `openllm` provider (a
  multi-model gateway) doesn't reliably honor `response_format: json_schema` guided decoding for
  every model behind it, so a text-instruction safety net was added - this self-heal is the second,
  complementary layer: even if the instruction-level nudge isn't enough, one corrective round trip
  usually recovers a well-formed response instead of surfacing a hard failure to the caller.

### 🔄 Changed — retry/backoff, observability, and test coverage for the gRPC transport

- `invokeHost` now retries transport-level `UNAVAILABLE` failures (connection refused/DNS
  failure/transient blip - request never reached the server) with exponential backoff + full
  jitter, up to `SDK_GRPC_MAX_RETRIES` (default 2) attempts. Deliberately does **not** retry
  `DEADLINE_EXCEEDED`/`INTERNAL`/application-level failures - the request may have already been
  processed server-side and there's no idempotency-key mechanism to make re-sending those safe.
  Override per-call via `InvokeRequest.maxRetries` (`0` disables retries for that call).
- New `onCall(listener)` export - a lightweight, dependency-free observability hook that fires
  `{ namespace, durationMs, attempts, success, error? }` after every call finishes. Wire it to
  OpenTelemetry/Datadog/whatever the host project already uses. Set `SDK_DEBUG=true` to also log
  every call's timing to the console without wiring anything up.
- `SDKClient` now accepts an `invoke` override in its constructor options (transport dependency
  injection) - used by the new unit tests, not meant for production plugin code.
- Added `test/grpcInvoker.test.ts` (retry/backoff behavior) and `test/sdkClient.test.ts`
  (`call`/`a2a`/`ask`/`hil`/`stream` behavior, including the agent-id-vs-search-query heuristic,
  now exported as the pure function `looksLikeAgentId`) - the core runtime paths previously had
  zero test coverage.

### 🆕 Added — `aivin plugin trigger`

Invoke an already-deployed plugin directly from the CLI and print the result - the same
`POST /plugins/execute` the platform's browser Playground ("Thử nghiệm" tab) uses
(`PluginExecutionService.executePlugin` on the backend), so it's the real execution path, not a
simulation.

- Direct mode: `aivin plugin trigger "<mission>" '<input JSON>'`.
- Auto mode: `aivin plugin trigger -a "<natural-language prompt>"` - sends the prompt as `raw_text`
  instead of structured input; the backend's own `mapDataToSchema` maps it onto `manifest.json`'s
  `input` schema for you (the same mechanism the Playground's chat-style tester uses). `<input>` can
  still be passed alongside `-a` to force specific fields - explicit values win over auto-mapped
  ones.
- `--func <name>` picks which entry to trigger for a multi-function plugin.
- Prints the backend's `processing_log` (mapping/execution stage messages) and, in auto mode,
  `mapped_arguments` (what the prompt got mapped to), then the real `status`/`message`/`data`.
- Real-time log streaming like the browser Playground's live panel isn't available here - that goes
  over a Socket.IO channel that only authenticates browser session JWTs, not a CLI API key. This
  only has what the HTTP response itself carries, printed once the call completes - not the
  plugin's own internal `console.log()` output either, just the backend's own orchestration steps.

### 🔄 Changed — simplified `aivin mcp create`

`--transport` and `--kind` no longer need to be spelled out in non-interactive/scripted use - both
are inferred from whichever flags you actually pass (`--command` implies `stdio`, `--url` implies
`sse`; `--tool-name`/`--resource-uri`/`--prompt-name` each imply their own `--kind`). Cuts the
common case (wrapping a tool) from 6 flags down to 3-4.

### 🆕 Added — `aivin plugin convert`

Turn a project you already have into a plugin without writing the wrapper by hand. Same AI code
generator as `plugin make` (`POST /code/generate`), but instead of a plain-language description it
reads the current directory as context (same exclusions as `aivin deploy`, plus a size cap) and asks
the AI to adapt the project's real, existing logic into `main(mission, input, ctx)` - preserving
behavior, not stubbing it out. No `aivin create` needed first - infers a starting `manifest.json`
from `package.json` if one doesn't exist yet. Accepts an optional hint: `aivin plugin convert "focus
on the exportInvoice function"`.

### 📝 Docs — sharper field descriptions, wording pass

- `depend_on`: now correctly describes the real mechanism (`DependencyResolverHelper` on the
  backend) - the dependency is scheduled into an earlier execution stage, not just "called first".
- `input`/`output`: no longer reference `main()` specifically (misleading for multi-function
  plugins). `input` now notes it supports nested structures and is read by the planner's
  auto-mapping; `output` now notes it's read during audit/replanning and for mapping this plugin's
  result into a later stage's input.
- `version`/`author`/`email`/`license`/`repository_url` split into individual table rows instead of
  being crammed together.
- Fixed the marketing site link (`aivin.app` → `aivin.cloud`, matching the real `api.`/`brain.`
  subdomains).
- General wording pass on README.md for a more dev-convenience-first tone (Environment variables,
  Turn anything into a plugin, a few "Why the SDK" bullets).

### 🐛 Fixed — `aivin create <name>` didn't actually work

The README/CLI.md/AI-Plugin-Guide.md quickstart has always shown `aivin create my-plugin` followed
by `cd my-plugin` - but the `create` command never declared a positional argument, so that literally
failed with `too many arguments for 'create'`. Even `aivin create --name my-plugin` "worked" but
never created a `my-plugin/` directory - it scaffolded into the current directory regardless,
leaving nothing to `cd` into. Fixed: `create` now takes an optional `[name]`; when a name is given
(positional or `--name`) it creates and scaffolds into a new `<name>/` subdirectory (matching `aivin
mcp create <name>` and the `--json`/`--stdin` path, both of which already worked this way) and skips
the now-redundant name prompt. Bare `aivin create` (no name) is unchanged - interactive prompts,
scaffolds into the current directory.

Also fixed: the scaffolded `manifest.json`'s default `output` was `{ success: boolean, data, message
}` - `success` and `message` don't belong there (they duplicate `PluginResponse`'s own top-level
`status`/`message` fields, and nothing reads them), so every new plugin shipped with a schema that
contradicted `output`'s own documented purpose (describe `PluginResponse.data`, not a wrapper). Now
just `{ data: '...' }`, matching `aivin mcp create`'s manifest and every doc example.

### 🆕 Added — multi-function plugins

- **Entry point moved**: `handler.ts` at the project root is now `src/main.ts`. `aivin create`
  scaffolds it there; `PluginServer.loadPlugin()` reads it from there.
- **Multi-function manifests**: `manifest.json` can now be `{ ...commonFields, plugins: [...] }` -
  fields shared by every function (`version`, `connection_id`, ...) written once, plus a `plugins`
  array where each entry is a full manifest plus a `func` field naming which export of the shared
  `src/main.ts` it calls. Each entry is deployed/discovered as its own independent plugin `id` -
  export as many named functions as you like from one `src/main.ts` and give each its own entry
  instead of maintaining a separate project per function. `manifest.json` is always one JSON object,
  never a bare top-level array - `flattenManifestFile()` (`src/types/PluginTypes.ts`) expands the
  `plugins` array into the flat, per-entry shape (`MultiFunctionManifestEntry[]`) that deploy/runtime
  actually work with internally, and now throws a clear error if `manifest.json` is a bare array.
- **New type**: `MultiFunctionManifestEntry` (`PluginManifest & { func: string }`) in
  `src/types/PluginTypes.ts`.
- `aivin deploy`/`aivin test` now accept a multi-function manifest directly: the request omits the
  top-level `id` and includes `files` unless every entry is a proxy plugin.
- **Backend: real one-container-many-functions deploy path.** The array-manifest branch of
  `deployUnified()` previously only registered manifest rows in the DB (no `files` handling at all,
  no Docker build) - a multi-function deploy looked like it succeeded but had no code behind it and
  could never actually be invoked. `PluginDeploymentService.deployMultiFunctionBatch()` now runs the
  security check/Docker build once for the shared code and registers all N entries with
  `proxy_config: { type: 'docker', code_id: <shared group id> }`. `PluginRunner.handleDockerRuntime`
  now addresses the container by `code_id` instead of `manifest.id` - these were never actually the
  same value even for a single-function plugin (`prepareDeployManifest` sets `code_id: plugin.id`
  but then reassigns `manifest.id` to a freshly-generated one on every deploy), so this wasn't just a
  multi-function fix: the previous `manifest.id`-keyed addressing never matched the real community
  directory or docker-compose service name for any Docker-runtime plugin. Also now passes each
  entry's `func` to the container explicitly via `context.metadata.func`, so `PluginServer` no longer
  has to guess the target function from `mission` (which is just a human-readable reason string, not
  a routable id) for a real host-triggered invocation - see `src/PluginServer.ts`'s
  `resolveTargetFunction()`. Mission-based matching against the local array manifest remains as a
  fallback, used only by `aivin start`'s local dev/curl testing.
- **Backend: fixed several `DeveloperPluginManifest` fields that were silently dropped on save.**
  `sdk_scopes`, `timeout_ms`, `circuit_breaker`, `stacks`, `side_effect`, `requires_human`, `rate_limit`,
  `network_config`, and the new `func` were read all over the plugin execution code but never
  declared on `PluginModel`'s (strict-mode) Mongoose schema, so Mongoose stripped them before every
  save/update - they never actually persisted regardless of what was set in `manifest.json`.
  `sdk_scopes` in particular has always silently no-op'd (`PluginBridge.enforceSdkScope` always saw
  `undefined` and fell back to full access) despite being documented as enforced. Fixed on the
  backend regardless of the SDK's own decision below to no longer surface `sdk_scopes` as a
  developer-facing manifest field - the persistence bug applies to any manifest that sets it, from
  any source, not just this SDK.
- **Backend: `rate_limit` and `network_config` had the exact same undeclared-schema bug** -
  automatic plugin rate limiting has never actually applied to anything, and an admin's network
  access approval/revocation (`AdminPluginService.updatePluginNetworkConfig`) never actually
  persisted either. Also closed a related gap: `network_config.is_network_approved` was never
  stripped from a developer's own submitted manifest, and `DockerHelper` reads it from the
  in-memory manifest *before* any DB round-trip - so a manifest simply declaring
  `"network_config":{"is_network_approved":true}` granted itself real internet egress with no admin
  review at all. Deploy now always ignores what's submitted and carries forward whatever's already
  admin-approved for that plugin instead (by `code_id`, so approval survives redeploys).
- **Backend: fixed the deployed plugin id never being reported back correctly.** `prepareDeployManifest`
  reassigns `manifest.id` via `generateId()` on every single-plugin deploy (never equal to what was
  submitted), but the deploy response only ever echoed back the submitted id - so the CLI (and any
  other caller) had no way to learn the real, queryable id a freshly-deployed plugin was actually
  saved under, breaking every subsequent `/plugins/execute` call by id. Fixed for both the JSON and
  ZIP single-plugin deploy paths; the CLI now writes back the correct id.
- **Backend: closed a privilege-escalation path in `@AllowApiKey()`'s fallback auth.** It never
  checked the API key's `scopes`, so a workspace-scoped key (`scopes: ['mcp']`, meant to restrict a
  low-trust third party to exactly one workspace) could use these routes to list every workspace on
  the account or execute a plugin in an arbitrary workspace the key owner administers. Now requires
  `full_access` scope, matching the account-wide nature of these routes.

### 🆕 Added — `aivin login` (browser flow) and machine-wide credentials

- **New default flow**: `aivin login` opens your browser to the platform's real login page instead
  of only prompting for email/password in the terminal. After you log in and confirm an "Aivin CLI
  wants to create an API Key" prompt, a fresh key is minted (named after this machine's hostname,
  replacing any previous key with the same name) and handed back to a one-shot local HTTP server the
  CLI starts for the callback.
- **`aivin login --basic`**: the previous terminal-only email/password flow, kept as a fallback for
  environments without a browser.
- **Machine-wide storage**: the API key is now saved once to `~/.aivin/credentials`, not a
  per-project `.env`. Every plugin project on the machine picks it up automatically; a project's own
  `.env` can still set `API_KEY=` directly to override it for that one project.

### 🆕 Added — `aivin test` smoke-test + report

- After a successful test-deploy, `aivin test` now generates sample input from `manifest.json`'s
  `input` schema, actually invokes the deployed plugin, and writes a pass/fail report to
  `.test/<timestamp>.json` (excluded from future deploy uploads). New options: `--workspace <id>`
  and `--no-smoke-test`.

### 🗑️ Removed — `is_public` / `aivin deploy public`

`manifest.is_public` and the `aivin deploy [personal|public]` scope argument are gone. The field was
dead on the backend: `PluginModel`'s schema never declared it (silently stripped on save, so it was
always `undefined` after a round-trip regardless of what was deployed), and nothing in
`PluginStoreService`/`PluginDeploymentService` ever read it for any real gating - setting it never
actually submitted a plugin to the public store. The real "public store" visibility check
(`PUBLIC_STORE_FILTER`) is based on `verification_status`/`is_official`/the plugin's `client`, none
of which a CLI deploy can set. The only actual "submit for community review" path today is the
browser CodeEditor's `publish_scope: 'community'` flow (`/code/publish`), which this CLI has no
equivalent of. `aivin deploy` is now unconditionally private to your org.

### 🔄 Changed — simplified environment variables

- **Local test shim port**: default changed from `3001` to `4001` (`3001` collided with the Aivin
  backend's own default dev port). Still overridable via `LOCAL_TEST_PORT`.
- **Removed** `LOCAL_TESTING` (the shim now just follows `NODE_ENV`) and `AIVIN_CLIENT` (only the
  `--client` flag remains for `login --basic`).
- **Confirmed real defaults**: `AIVIN_BASE_URL` defaults to `https://api.aivin.cloud`,
  `AIVIN_WEB_URL` defaults to `https://brain.aivin.cloud` (previously required with no default).
- Docs now surface only the handful of variables a developer would ever plausibly set
  (`API_KEY`, `SDK_GRPC_ENDPOINT`, `AIVIN_BASE_URL`, `AIVIN_WEB_URL`, `LOCAL_TEST_PORT`) — the rest
  are auto-managed or have working zero-config defaults.

### 🆕 Added — MCP proxy plugins

- **New CLI command**: `aivin mcp create <name>` scaffolds a manifest-only plugin (`proxy_config`)
  that proxies straight to an external MCP server's tool/resource/prompt — no `src/main.ts`/code
  needed. Matches the backend's `McpProxyConfig` (`src/plugins/dto/proxy/McpProxyConfig.ts`)
  field-for-field.
- **New manifest field**: `proxy_config` (typed via the new `PluginProxyConfig`/`McpProxyConfig`
  exports), mirroring `DeveloperPluginManifest.proxy_config` on the backend.
- `aivin deploy`/`aivin test` now detect `proxy_config` automatically and send the manifest alone —
  the `files` key is omitted entirely (not sent empty) so the backend's manifest-only deploy branch
  is actually reached.

### 🔍 Fixed — SDK client audited against the real backend implementation

Every `ctx.sdk.*` param shape was re-verified against the backend's real `src/base/SDK.ts` (not
just `CodeSDK.d.ts`, which turned out to diverge from the live implementation in several places).
Fixed: `ai.getEmbeddings`/`ai.rerank` param shapes, `saveConnection`, `a2a`'s auto-resolution of a
search query to an agent ID, `task.update/getById/delete`, `notification.push/sendMail`,
`message.save`, `datastore.updateRow/deleteRow/smartQuery/batchUpdateByAI/batchDeleteRows`,
`store.transaction`'s per-operation `table_id`, and `mongo.model(name)`'s Mongoose-style shape.
Removed sugar methods that don't actually exist on the real SDK (`ai.tts/stt/getModels/calculateTokens`,
`knowledge.store/get/del/reinforce`, `agent.ask/hil`, `task.gen/addComment/requestSupport`, the
standalone `think` namespace — replaced by `causality.think/absorb`). Docs (`docs/SDK.md`,
`docs/EXAMPLES.md`) updated to match.

### 💥 Breaking — full rewrite of the transport layer and CLI

The SDK previously talked to the backend over Redis Pub/Sub (`RedisIO`, `PubSubIO`, `ContextIO`,
`LLMIO`, `MongoIO`, `BullIO`) — a protocol the live backend no longer implements at all. Verified
against the real backend (`src/base/sdk/`, `src/plugins/`) and rewrote to match:

- **New transport**: gRPC (`SdkTransportService.Invoke`, `src/proto/sdk_transport.proto`), the same
  proto used both directions — plugin → host (`ctx.sdk.*`) and host → plugin (running `main()`).
- **New client**: `SDKClient` (`ctx.sdk`) — full parity with the backend's own `CodeSDK.d.ts`
  (`ai`, `vector`, `knowledge`, `task`, `store`, `redis`, `mongo`, `workspace`, `agent`, `realtime`,
  `queue`, and more). Removed `RedisIO`/`PubSubIO`/`ContextIO`/`LLMIO`/`MongoIO`/`BullIO` and their
  DTOs entirely — nothing left that talks to the old protocol.
- **New `PluginServer`**: a real gRPC server (was a Bull-queue worker pulling jobs — the opposite
  direction from how the backend actually invokes Docker-runtime plugins).
- **New `manifest.json` schema**: mirrors the backend's `DeveloperPluginManifest` field-for-field
  (`sdk_scopes`, `connection_id`, `timeout_ms`, `initable`, ...).
- **New CLI commands**: `aivin plugin make "<description>"` (AI codegen via the real `/code/generate`
  endpoint, prompted to target this SDK's conventions), `aivin test` (deploy to a non-production
  test instance via `/plugins/test/deploy`), `aivin deploy` (real `/plugins/deploy`, always private
  to your org).
- **Removed**: the old "stacks" concept (`AI_LLM`/`REDIS_CACHE`/`MONGODB`/`BACKGROUND_JOBS`) and the
  docker-compose sidecar generation it drove — storage/realtime/queue are now host-mediated via
  `ctx.sdk`, so plugins never receive raw database credentials.
- Also fixed along the way: `aivin deploy`'s broken `axios.post` call (Authorization header was
  never actually sent), an event-listener leak in the old Bull-based job tracking, and several
  stale/duplicated doc pages describing an architecture that no longer existed.
- **Removed** the named `import { sdk } from '@aivin-labs/sdk'` export — it was a redundant spelling of
  the default import (`import SDK from '@aivin-labs/sdk'`). Use the default import, per-namespace
  imports (`import { ai, store } from '@aivin-labs/sdk'`), or `ctx.sdk`.

### Fixed (previous entry, 2024-12-19)

### 🔧 Fixed

- **Khởi tạo trùng lặp**: Sửa lỗi `RedisIO.init()` được gọi 2 lần (trong `index.ts` và `PubSubIO.init()`)
- **PubSubIO**: Loại bỏ việc gọi `RedisIO.init()` trong `PubSubIO.init()` để tránh khởi tạo trùng lặp

### 🆕 Added

- **BullIO Types**: Thêm các types mới vào exports
  - `JobFailedError`: Error handler cho job thất bại
  - `JobHandler`: Type definition cho job handler functions
  - `JobProcessor`: Interface cho job processor configuration
- **Context Types**: Cập nhật ContextDTO để đồng bộ với source DTOs
  - `User`: Thêm các fields mới từ UserDTO (`name`, `email`, `phone`, `gender`, etc.)
  - `Task`: Cập nhật từ TodoModel với đầy đủ fields (`order`, `key`, `step`, `handler_history`, etc.)
  - `HandlerHistory`: Interface mới cho lịch sử xử lý task
  - `Workspace`, `Project`, `Message`, `Session`: Các interfaces mới từ DTOs tương ứng
- **GenderType**: Enum mới cho giới tính (`MALE`, `FEMALE`, `OTHER`)

### 🧹 Cleaned

- **PubSubDTO**: Loại bỏ các interfaces không cần thiết
  - Xóa 12 legacy interfaces không sử dụng
  - Giữ lại 8 interfaces cần thiết cho SDK
  - Giảm 60% số interfaces không cần thiết
- **ContextDTO**: Loại bỏ các Request interfaces
  - Xóa `LoginRequest`, `WorkspaceRequest`, `ProjectRequest`, etc.
  - Các interfaces này không cần thiết trong SDK (chỉ dành cho API endpoints)

### 📚 Documentation

- **DATA_STRUCTURES.md**: Cập nhật toàn bộ types documentation
  - Thêm phần Context Types với examples
  - Thêm phần BullIO Types với advanced usage
  - Cập nhật import statements
- **README.md**: Cập nhật hướng dẫn khởi tạo
  - Thêm cảnh báo về tự động khởi tạo
  - Cập nhật environment variables
- **PubSubIO.md**: Cập nhật phần khởi tạo để phản ánh fix

### 🔄 Changed

- **Initialization**: SDK bây giờ tự động khởi tạo khi import
- **Type Safety**: Tăng cường type safety với các interfaces mới
- **Maintainability**: Cải thiện khả năng bảo trì với code sạch hơn

### 📊 Statistics

- **Types**: Thêm 15+ interfaces và types mới
- **Cleanup**: Loại bỏ 60% interfaces không cần thiết
- **Documentation**: Cập nhật 100% tài liệu liên quan
- **Bug Fixes**: Sửa 1 lỗi khởi tạo trùng lặp quan trọng
