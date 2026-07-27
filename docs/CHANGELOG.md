# Changelog

## [Unreleased] - 2026-07-27 (2)

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

## [Unreleased] - 2026-07-27

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

## [Unreleased] - 2026-07-26

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
