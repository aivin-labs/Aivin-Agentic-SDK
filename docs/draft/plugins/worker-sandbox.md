# Design draft: worker-thread sandbox for plugin `main()`

Status: **Phase 1 implemented**, behind `AIVIN_SANDBOX_WORKER=true` (default off - see
[`@aivin-labs/cli`'s CLI.md#environment-variables](https://github.com/aivin-labs/cli/blob/main/docs/CLI.md#environment-variables)). Written in response to the residual risk noted in
`docs/SECURITY.md`'s "Future direction: a credential-holding sidecar" section - this is one way to
build that sidecar *inside* the same OS process (a `worker_threads.Worker`) instead of as a
separate process, avoiding new process-supervision/IPC-transport work while still getting the two
concrete properties that section asks for.

## Implementation notes (Phase 1, as actually shipped)

The design below matches what shipped, with a few simplifications discovered while building it:

- **No `RemoteSDKClient` needed.** `SDKClient` already accepts `invoke`/`invokeStream` overrides
  via its constructor (`SDKClientOptions`, originally added for unit tests) - the worker just
  constructs a normal `SDKClient` with those two swapped for relay functions. Every typed namespace
  method (`ai.*`, `table.*`, ...) keeps working unmodified.
- **No `console.log` relay message.** A `worker_threads.Worker`'s stdout/stderr pipe to the parent
  process's real stdout/stderr by default (verified directly) - `trace.ts`'s existing
  `installConsoleCapture()` (which runs the moment the worker imports `trace.ts`, same as the
  non-sandboxed path) handles capture/redaction locally inside the worker's own module instance, no
  extra protocol needed.
- **`GrpcInvoker.ts`'s private `emitTrace` is now exported** (was already called via the
  test-only `emitTraceForTest` escape hatch) - the worker's relay functions call it directly after
  a relayed call/stream resolves, so `CallTrace` bookkeeping (and therefore `trace.events`) works
  identically to the non-sandboxed path instead of silently staying empty.
- **Shared plugin-loading logic extracted to `src/pluginLoader.ts`** (`loadPluginModule`,
  `resolveTargetFunction`, `summarizeManifest`, `readManifest`) - used by both `PluginServer`
  (direct load) and `worker/PluginWorkerRuntime` (same load, inside the worker), so the two paths
  can't silently diverge in how they resolve a plugin project.
- **Env allowlist is just `NODE_ENV`** for now (see "Env filtering" below) - nothing else is
  forwarded into the worker's `process.env` by default.
- **Long-lived worker, not one-per-invocation** - per the "Open questions" recommendation below.
  `reload()` terminates and respawns a fresh worker (empty module cache by construction) rather
  than reusing the non-sandboxed path's cache-busting `?t=timestamp` trick.
- **Verified against a real fixture plugin + Node's Permission Model**, not just unit-tested in
  isolation - `test/pluginWorkerHost.test.ts` proves a sandboxed plugin's own `fs.readFileSync()`
  outside its project directory and `child_process` spawn both fail with `ERR_ACCESS_DENIED`,
  while the same plugin's real `ctx.sdk.call()` still round-trips correctly through the relay.

Not yet done (tracked as future phases, not blocking this one): the Phase 2-5 rollout plan below
(dogfooding against a real deployed plugin, benchmarking, flipping the default), `resourceLimits`,
and resolving the "Open questions" that don't block a default-off flag (env allowlist mechanism,
rollout gating).

## Problem recap

Today, `PluginServer.loadPlugin()` `import()`s a plugin's `src/main.ts` directly into the same
V8 context as the SDK client, on the main thread. The plugin's own code therefore has full Node.js
capability - `fs`, `child_process`, arbitrary network, all of `process.env` - for the lifetime of
the container. `docs/SECURITY.md` already documents this as accepted (cap-scoping, not secrecy, is
the real tenant-isolation boundary) but two things are still worth closing, independent of that:

1. The raw `secret` (proves "a real container the host spawned") sits one `resolveSdkSecret()` call
   away from any code running in the container, including a compromised dependency of the plugin's
   own `package.json` - not just the plugin author's own code.
2. There's no reduction of blast radius for a plugin (or one of its dependencies) that does
   something Node-level malicious that has nothing to do with the SDK at all - reading arbitrary
   container filesystem, spawning processes, etc.

## Goals / non-goals

**Goals**
- The plugin's own code never has direct access to `SDK_SECRET_FILE` / the resolved secret value,
  or to `~/.aivin/credentials`-shaped material generally.
- Reduce the plugin's filesystem/process capability to only what it actually needs (its own `src/`
  and dependencies), not the whole container.
- Zero change to the plugin-author-facing API - `import { ai, table } from '@aivin-labs/sdk'`,
  `ctx.sdk.*`, streaming, tracing, hot-reload all keep working exactly as they do today.

**Non-goals**
- Not defending against a plugin exfiltrating data it's legitimately allowed to see via its own
  `cap` - that was never in scope for `cap`/`secret` either, see `docs/SECURITY.md`.
- Not restricting network egress - Node's Permission Model has no `--allow-net` as of the versions
  this SDK targets. A plugin can still make arbitrary outbound HTTP calls; that's inherent to what
  a plugin is *for*.
- Not a CPU/memory resource-exhaustion control (see "Adjacent, optional" below for a cheap add-on).

## Architecture

```
Container OS process
├── Main thread — "Host" (trusted, unchanged trust boundary)
│   PluginServer (existing)
│    - owns SDK_SECRET_FILE / SDK_SECRET / cap resolution (unchanged)
│    - owns the real GrpcInvoker client - the ONLY thing that ever dials the backend
│    - NEW: PluginWorkerHost — owns the Worker, the RPC relay, env/permission setup
│
│           worker_threads.MessagePort (structured-clone IPC, in-process)
│
└── Worker thread — "Plugin runtime" (untrusted)
    NEW: PluginWorkerRuntime
     - import()'s src/main.ts (moved here, same dynamic-import mechanism as today)
     - ctx.sdk is a stub client: every method posts a message to the host and awaits the reply,
       instead of calling GrpcInvoker directly
     - console.* wrapped the same way trace.ts does today, but forwards lines to the host instead
       of redacting+storing locally (worker never needs the secret to redact against - see below)
     - process.env: explicit small allowlist, NOT the default full copy
     - spawned with Node's Permission Model flags restricting fs/child_process/worker
```

## New components

### `src/worker/PluginWorkerHost.ts` (main thread)

- Spawns and owns a single long-lived `Worker` running `PluginWorkerRuntime` (see "Open questions"
  for worker-per-invocation as an alternative).
- Constructs the Worker with:
  - `env`: an explicit filtered object, **not** the default full-`process.env` copy Node gives a
    Worker otherwise. See "Env filtering" below.
  - `execArgv`: Permission Model flags. See "Permission Model" below.
  - `workerData`: non-secret config only (plugin src dir, manifest path).
- Handles every inbound message from the worker:
  - `sdk.call` → runs the real `invokeHost()` (existing `GrpcInvoker`, unchanged) with the resolved
    `secret`, replies with the result.
  - `sdk.stream.start` → runs `invokeHostStream()`, relays chunks back as they arrive.
  - `console.log` → this is where `redactSensitive()` (existing, from `trace.ts`) now runs - host
    has the secret, worker doesn't, so redaction happens exactly once, in the one place that
    actually holds the thing being redacted.
  - `invoke.done` → resolves/rejects the outer `testInvoke()`/gRPC-handler promise that kicked off
    this invocation.
- `reload()`: **terminates the current worker and spawns a fresh one**, rather than reusing today's
  cache-busting `?t=timestamp` re-import trick. A fresh Worker has an empty module cache by
  construction, which is strictly more correct than cache-busting a shared one, and Worker startup
  for a small plugin script is cheap enough for dev-loop hot-reload (needs measuring - see
  "Testing strategy").
- Enforces the existing per-call `timeoutMs` from the host side; can `worker.terminate()` a hung
  worker as a last resort and respawn, same failure-recovery shape a hung gRPC call needs today.

### `src/worker/PluginWorkerRuntime.ts` (runs inside the Worker)

- Replaces `PluginServer.loadPlugin()`'s body for the sandboxed path - same
  `pathToFileURL(...).href + (cacheBust ? '?t=...' : '')` dynamic-import mechanism, just executing
  inside the worker's own module scope.
- Constructs a `RemoteSDKClient` (new, replaces direct `SDKClient` construction for this path) whose
  `.call(namespace, method, params)`:
  ```ts
  const requestId = crypto.randomUUID();
  parentPort.postMessage({ type: 'sdk.call', requestId, namespace, method, params, timeoutMs });
  return new Promise((resolve, reject) => pendingCalls.set(requestId, { resolve, reject }));
  ```
  with a matching `parentPort.on('message', ...)` that resolves/rejects on `sdk.call.result`.
- `vector.similarity`/`vector.normalize` (pure local math today, no network round-trip) stay
  entirely in-worker with zero protocol involvement - no reason to pay a message round-trip for
  something that never left the process anyway.
- Reinstalls the same `console.*`-wrapping capture as today's `installConsoleCapture()`, but each
  captured line is `parentPort.postMessage({ type: 'console.log', level, ts, seq, message })`
  instead of pushing into a local trace array - the trace object itself now lives host-side.
- `cap` (the short-TTL, tenant-scoped bearer) is still handed to the worker as part of the initial
  `invoke` message, unchanged from today - `cap` was never the thing this design protects the
  plugin from having (see `docs/SECURITY.md`: `cap`'s job is confining the plugin even assuming it
  has the value, not hiding it). Only `secret` moves host-only.

### `src/worker/protocol.ts` (shared message types, imported by both sides)

Worker → Host:
- `{ type: 'sdk.call', requestId, namespace, method, params, timeoutMs?, maxRetries? }`
- `{ type: 'sdk.stream.start', requestId, namespace, method, params }`
- `{ type: 'console.log', level, ts, seq, message }`
- `{ type: 'invoke.done', requestId, ok, result?, error? }`

Host → Worker:
- `{ type: 'invoke', requestId, mission, input, identity, cap }`
- `{ type: 'sdk.call.result', requestId, ok, data?, error }`
- `{ type: 'sdk.stream.chunk' | 'sdk.stream.end' | 'sdk.stream.error', requestId, ... }`

All correlated by `requestId` (`crypto.randomUUID()`); concurrent invocations on the same long-lived
worker stay correctly attributed via the worker's own `AsyncLocalStorage`, mirroring the existing
`invocationStorage`/`traceStorage` pattern - the relay changes *where* a call physically executes,
not the concurrency model plugins already run under.

## Env filtering

Default allowlist forwarded into the worker's `env`: **`NODE_ENV` only.** Everything else needs to
be either:
- A plugin-declared config value (existing `manifest.json` config block - no new mechanism needed,
  just route it through explicitly instead of blanket `process.env` passthrough), or
- Denied outright if it matches `/SECRET|TOKEN|PASSWORD|_KEY$/i` even if someone tries to add it to
  an allowlist later - a blanket denylist as a second layer, not just an allowlist by omission.

This is a strict improvement over today regardless of the rest of this design: right now a plugin
sees the *entire* container environment, including anything an operator happened to set there for
unrelated reasons.

## Permission Model

```ts
new Worker(runtimeEntryPath, {
  execArgv: [
    '--experimental-permission',
    `--allow-fs-read=${pluginSrcDir}/*`,
    // no --allow-fs-write (plugin shouldn't need to write into its own container fs by default -
    // revisit with a narrow, explicit scratch dir if a real use case shows up)
    // no --allow-child-process, no --allow-worker - omission = denied
  ],
  env: filteredEnv,
  workerData: { pluginSrcDir },
});
```

**Caveat, stated plainly:** Node's Permission Model is still experimental in the Node versions this
SDK targets (`engines.node: >=22.0.0`). Treat this as defense-in-depth on top of the env-filtering
above, not as a hard guarantee on its own - same "safety net, not a proof" framing already used for
`redactSensitive()` in `trace.ts`. It also has no network-layer permission at all, which is why
network egress is explicitly a non-goal above.

## Serialization across the worker boundary

`postMessage` uses the structured clone algorithm: plain objects/arrays/Map/Set/Date/RegExp/Error
all clone fine (custom `Error` subclasses lose their specific prototype and arrive as a plain
`Error` with the same `message`/`stack` - `RemoteSDKClient` should re-wrap into the SDK's own error
type where one exists, so `catch (e) {}` in plugin code doesn't observe a difference). Functions,
class instances with real methods, and Promises do **not** clone.

Binary payloads (`MediaItem.file`, `ai.image`/`ai.video` results carrying inline base64/Buffer data)
should use `transferList` for `ArrayBuffer`-backed values above some size threshold (TBD via
benchmarking) to avoid an extra copy - a zero-copy ownership transfer instead of a clone.

## Migration plan

1. **Phase 1** — build `PluginWorkerHost`/`PluginWorkerRuntime`/protocol behind
   `AIVIN_SANDBOX_WORKER=true` (default off). Fully additive: `PluginServer.loadPlugin()` /
   `handleInvoke()` keep working exactly as today when unset.
2. **Phase 2** — dogfood against `test-sdk`'s existing harness (the same ~140-call sweep already in
   `.test/report.md` today) run through the worker path; diff the pass/skip/fail profile against the
   non-sandboxed run - it should be identical.
3. **Phase 3** — benchmark per-call overhead (message round-trip vs direct call) and worker
   spin-up cost for `reload()`; confirm both are acceptable for the dev hot-reload loop and for
   production invocation latency.
4. **Phase 4** — flip default to on for new deployments (manifest-version-gated or similar), keep
   the env escape hatch for anyone who hits a real compatibility gap (e.g. a plugin doing
   synchronous fs access to something outside the allowlisted directory).
5. **Phase 5** — deprecate the non-sandboxed path once stable.

## Testing strategy

- Protocol round-trip unit tests (every message type, including error replies).
- Integration test against a fixture plugin calling `ctx.sdk.ai.prompt()` with a mocked host-side
  handler - confirms the relay actually works end to end.
- **The regression tests that actually prove the security property**, not just that it compiles:
  - fixture plugin that tries `fs.readFileSync(process.env.SDK_SECRET_FILE ?? knownDefaultPath)` →
    must throw under the Permission Model restriction.
  - fixture plugin that tries `require('child_process').exec(...)` → must throw.
- Concurrency test mirroring the existing "console capture isolates concurrent invocations from each
  other" test in `test/trace.test.ts`, run through the relay.
- Hot-reload test: `reload()` fully terminates the old worker (no lingering listeners) and the new
  one picks up the new source.

## Adjacent, optional: resource limits

Not required for the security goals above, but cheap to add alongside since it's the same `Worker`
constructor call: `resourceLimits: { maxOldGenerationSizeMb, maxYoungGenerationSizeMb }` caps a
runaway plugin's memory instead of the container OOM-killing the whole process (gRPC server
included). This is an *availability* control, not a confidentiality one - worth tracking as a
follow-up, not blocking this design.

## Residual risks (stated plainly, same spirit as `docs/SECURITY.md`)

- Doesn't stop a plugin from exfiltrating data it's legitimately allowed to see via its own `cap` -
  never in scope; `cap` is the actual tenant-isolation boundary regardless of this design.
- Doesn't restrict network egress at all.
- Permission Model is experimental tooling - defense-in-depth, not a proof.
- A worker crash/OOM needs a clean respawn path host-side; failure granularity (today: one bad
  plugin call fails just that one gRPC call) needs to be preserved and explicitly tested, not
  assumed.

## Open questions

1. **Long-lived shared worker vs one worker per invocation.** This draft recommends long-lived
   (matches today's performance profile; concurrent invocations already rely on `cap` for isolation,
   not process boundaries) — but it's a real tradeoff against stronger per-invocation crash/state
   isolation, worth an explicit decision rather than defaulting silently.
2. Is `resourceLimits` in scope for this same effort, or a separate follow-up?
3. Env allowlist mechanism: reuse `manifest.json`'s existing config block as-is, or add an explicit
   `env_allowlist` manifest field?
4. Rollout gating: per-plugin opt-in (manifest field) vs global env flag vs eventually mandatory?
