# Contributing to the Aivin SDK

Thanks for your interest in improving `@aivin-labs/sdk` — the runtime library plugin code imports
(`ai`, `store`, `task`, ...) plus the gRPC transport/worker host that runs a plugin container. Bug
reports, focused feature requests, and pull requests are all welcome.

> Looking to build a *plugin* rather than change the SDK itself? You're in the wrong place — see
> the root [README.md](../README.md) and [`@aivin-labs/cli`'s Getting Started
> guide](https://github.com/aivin-labs/cli/blob/main/docs/GETTING_STARTED.md) instead.

## Setup

```bash
git clone https://github.com/aivin-labs/AIVIN-SDK.git
cd AIVIN-SDK
npm install
```

Requires Node.js ≥ 22 (see [README.md#requirements](../README.md#requirements)).

## Development workflow

```bash
npm run build   # tsc + copies src/proto/sdk_transport.proto into dist/proto
npm run dev      # tsc --watch
npm test         # node:test, no mocking framework - see AGENTS.md for the testing pattern
npm run lint     # eslint .
npm run format   # prettier --write .
```

Run `npm run build` after any source change before relying on `dist/` output (e.g. when testing
against a local plugin project via `npm link`).

Before opening a PR:

- `npm run lint && npm test` should pass.
- If you touched `src/proto/sdk_transport.proto` or anything under `src/worker/protocol.ts`, run
  `npm run check:contract` — it verifies the wire contract stays consistent.
- Update `docs/CHANGELOG.md` for user-visible changes.
- If behavior described in `README.md` or `docs/*.md` changed, update the relevant doc in the same
  PR — see [AGENTS.md](../AGENTS.md) for where each doc lives and what it covers.

## Code style

- TypeScript, no `any` where it can reasonably be avoided.
- Follow the existing namespace pattern (`src/sdk/*.ts`) when adding a new SDK surface — see
  [ARCHITECTURE.md](./ARCHITECTURE.md) for how a namespace call flows from plugin code to the host.
- No comments explaining *what* code does; only ones explaining a non-obvious *why*.

## Reporting bugs / requesting features

Open a [GitHub issue](https://github.com/aivin-labs/AIVIN-SDK/issues) with:

- SDK version (`npm ls @aivin-labs/sdk`) and Node version.
- For bugs: minimal repro (a snippet calling the SDK is usually enough — you don't need a full
  plugin project).
- For features: the use case you're blocked on, not just the API shape you'd want.

## Pull requests

- Keep PRs focused — one change per PR is easier to review and revert if needed.
- Add/update tests under `test/` for behavior changes.
- Link the issue it addresses, if any.

## License

By contributing, you agree your contributions are licensed under this project's [MIT
license](../LICENSE).
