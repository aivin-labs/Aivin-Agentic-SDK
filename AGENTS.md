# AGENTS.md

This is the `@aivin-labs/sdk` package itself (the client library + `aivin` CLI) - not a plugin
project. If you're instead working *inside* a project scaffolded by `aivin create`, that project
has its own `AGENTS.md` already; this one is for people/agents working on the SDK's own source.

## Layout

- `src/` - the published library (compiled to `dist/`). `src/sdk/SDKClient.ts` is the whole
  `ctx.sdk`/`import { ai } from '@aivin-labs/sdk'` surface; `src/grpc/GrpcInvoker.ts` is the
  transport (retry/backoff, streaming, tracing hooks); `src/PluginServer.ts` is the gRPC server a
  deployed plugin runs; `src/sdk/trace.ts` is the per-invocation execution trace.
- `bin/cli.mjs` - the `aivin` CLI (real ESM, not part of the compiled `dist/` - runs directly).
  `bin/server.mjs` is what `aivin start` spawns.
- `docs/` - the real reference. `docs/SDK.md` + `docs/sdk/*.md` (one file per namespace) is the
  full `ctx.sdk` surface; `docs/MANIFEST.md` is `manifest.json`'s field reference; `docs/CLI.md` is
  every CLI command; `docs/AI-Plugin-Guide.md` is the condensed cheat sheet for an AI generating a
  plugin quickly.
- `test/` - `node:test`, run via `npm test`. No mocking framework - fakes are passed in directly
  (see `SDKClientOptions.invoke`/`invokeStream` and `GrpcInvoker.emitTraceForTest`).

## Conventions specific to this repo

- Param shapes in `SDKClient.ts` are verified against the backend's real implementation
  (`src/base/SDK.ts` in the separate backend repo), **not** `CodeSDK.d.ts` - that declared type
  file has drifted from the real backend in several places. Doc comments on individual methods flag
  where a shape differs from what `CodeSDK.d.ts` would suggest.
- `@aivin-labs/sdk`'s own dependency on itself inside `bin/cli.mjs`'s scaffold generator
  (`createPackageJson`) must stay pinned to an **exact version**, not `latest`/a range - the
  platform's own deploy-time security scan flags non-exact pins as a supply-chain risk. Bump it
  there whenever you publish a new version, alongside `program.version(...)` at the top of
  `cli.mjs`.
- Prefer `import { ai, ... } from '@aivin-labs/sdk'` over `ctx.sdk.*` in every example, generated
  scaffold, and doc snippet - both resolve to the same client, but the import style is the
  documented default (`ctx.sdk` exists only for code that isn't guaranteed to run inside `main()`).

## Before publishing

`npm run build && npm run lint && npm test` must all pass. `prepublishOnly` already runs
clean+build, but lint/test are not wired into it - run them yourself first.
