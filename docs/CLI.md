# 🖥️ CLI Reference

`aivin` is built on [Commander](https://github.com/tj/commander.js), so help is always available
without needing this doc:

```bash
aivin --help            # or: aivin help
aivin <command> --help  # or: aivin help <command>
```

Every command below is real - this is the exact output of `aivin --help` as of this SDK version.

```
Usage: aivin [options] [command]

Aivin Plugin SDK - Build and run AI plugins

Options:
  -V, --version            output the version number
  -h, --help               display help for command

Commands:
  create [options] [name]  Create new plugin
  init [options] [name]    Set up a new plugin step by step: asks what it should
                           do, then generates real working code from that
                           description
  validate [options]       Validate manifest.json in the current directory (or
                           --json/--stdin for scripted use)
  start [options]          Start plugin server
  deploy                   Deploy plugin to your org on the Aivin server
  test [options]           Deploy to a non-production test instance, then
                           smoke-test it with generated input and save a report
                           to .test/
  plugin                   AI-assisted plugin authoring
  mcp                      MCP proxy plugins - wrap an external MCP server
                           tool/resource/prompt, no code required
  login [options]          Log in and save an API key for plugin deployment
                           (opens your browser by default)
  help [command]           display help for command
```

## `aivin init [name]`

The simplest way to start: asks what the plugin should do, then scaffolds the project **and**
generates real working code from that description in one step - no separate `aivin create` +
`aivin plugin make` needed.

```bash
aivin init my-plugin
# ? Plugin name: my-plugin
# ? What should this plugin do? (be specific - this is what generates your code)
#   > Summarize a support ticket and tag its urgency low/medium/high
```

Options:

```
Options:
  --name <name>          Plugin name (if not specified, will prompt)
  --model <model>        LLM model to use for generation
  --provider <provider>  LLM provider to use for generation
```

Writes two source files instead of one, unlike `aivin create`:

- **`src/service.ts`** - the actual business logic, AI-generated from your description. A single
  exported `execute(input, ctx)` that returns plain result data (or throws a plain `Error`) - no
  `PluginResponse`/`PluginStatus` boilerplate to think about.
- **`src/main.ts`** - a thin, static wrapper (not AI-generated, doesn't change between runs). Calls
  `execute()` and packages the result into the `PluginResponse` the platform expects. This filename
  is fixed - the runtime always loads exactly `src/main.ts`, so it's never regenerated or renamed.

If code generation fails (network issue, `API_KEY` not set, etc.), `aivin init` still leaves you
with a working, deployable scaffold - it falls back to the same plain placeholder `aivin create`
writes, so nothing is left half-broken.

Regenerating later: `aivin plugin make "<new description>"` detects `src/service.ts` and targets it
instead of `src/main.ts`, so the split is preserved (see below).

Prefer no AI step at all? `aivin create` scaffolds the same project structure minus the generation -
one `src/main.ts` you write by hand.

## `aivin create`

Scaffold a new plugin project (`manifest.json`, `src/main.ts`, `package.json`, `tsconfig.json`,
`.env`, `.gitignore`).

```
Usage: aivin create [options] [name]

Options:
  --json <config>  JSON config (AI mode)
  --stdin          Read from stdin
  --name <name>    Plugin name (if not specified, will prompt)
  --silent         Silent mode
  --json-output    JSON output
```

- `aivin create <name>` (or `--name <name>`) → creates a new `<name>/` subdirectory and scaffolds
  into it, no name prompt (description still prompted).
- No name at all → interactive prompts for both name and description, scaffolding into the
  **current** directory - `mkdir`/`cd` into your target folder yourself first.
- `--json '<config>'` / `--stdin` → non-interactive/scripted mode for AI tooling, also creates a
  `<config.name>/` subdirectory. `config` needs at least `name` and `description`; anything else
  (`input`, `output`, `trigger_type`, ...) is merged straight into the generated `manifest.json`.
  `config` may also be a path to a JSON file.
- `--json-output` → prints a machine-readable `{ success, pluginDir, name, description, timestamp }`
  result instead of the usual colored console output.

```bash
aivin create my-plugin
aivin create --json '{"name":"my-plugin","description":"Summarize tickets"}'
```

## `aivin validate`

Validates a plugin config against the same rules `aivin create` enforces (name format, required
`description`, and - if present - `proxy_config` completeness for MCP proxy plugins). Doesn't touch
the network.

With no flags, validates `manifest.json` in the current directory - the common case:

```bash
cd my-plugin
aivin validate
```

```
Options:
  --json <config>  JSON config, instead of reading manifest.json from the current directory
  --stdin          Read JSON config from stdin, instead of reading manifest.json
  --json-output    JSON output
```

`--json`/`--stdin` remain for scripted/CI use where the config isn't a file on disk yet:

```bash
aivin validate --json '{"name":"my-plugin","description":"x"}'
```

## `aivin start`

Runs `bin/server.mjs` in the current plugin directory (must contain `manifest.json` and
`src/main.ts`). Starts:

1. A real gRPC server (bind `0.0.0.0:50051`) - the same protocol the production host uses to
   trigger your handler(s). You don't call this directly.
2. In development (anything but `NODE_ENV=production`), an HTTP test shim on `:4001` (override with
   `LOCAL_TEST_PORT`) for manual `curl` testing.

```bash
aivin start
curl -X POST http://localhost:4001/invoke -H 'content-type: application/json' \
  -d '{"input":{"text":"hello"}}'
```

With more than one `plugins: []` entry, pass `mission` to pick which entry's `func` runs - it's
matched against each entry's `id`, falling back to `func` (a single-entry manifest, the scaffold
default, always resolves to its one entry - no `mission` needed):

```bash
curl -X POST http://localhost:4001/invoke -H 'content-type: application/json' \
  -d '{"mission":"summarize-ticket","input":{"text":"hello"}}'
```

SDK calls made while running default to the **production** backend (`api.aivin.cloud`) if
`SDK_GRPC_ENDPOINT` isn't set in `.env` - point it at a local/dev backend instead if you don't want
that (see [Environment variables](#environment-variables) below).

### Live per-call debugging: `--debug` / `--debug-json`

By default you only see a trace summary once the whole invocation finishes (`AIVIN_TRACE`, on by
default - see [Environment variables](#environment-variables)). To watch each `sdk.*` call as it
happens instead:

```bash
aivin start --debug        # human-readable: one line per call, live
aivin start --debug-json   # same events, one JSON object per line - for a script/coding agent
                            # to parse instead of pattern-matching free text
```

Both are `SDK_DEBUG=true`/`SDK_DEBUG=json` under the hood (settable directly if you're not going
through `aivin start`, e.g. inside `aivin test`'s smoke-test run). Each line/event covers exactly
one `sdk.*` call: `namespace`, `duration_ms`, `attempts`, `success`, `error` (if any).

## `aivin deploy`

Deploys the plugin in the current directory (`manifest.json` + every project file except
`node_modules/`, `.git/`, `.tmp/`, `dist/`, `build/`, `.test/`, `.gitignore`, `yarn.lock`, and
`.env`) to `POST /plugins/deploy`. Always private to your org - there's no CLI-reachable "submit to
the public store" path today (that only exists through the browser CodeEditor's publish flow, a
different runtime).

- `manifest.json` is normally the default `{ ...commonFields, plugins: [...] }` shape (see
  [MANIFEST.md#default-shape](./MANIFEST.md#default-shape)) - common fields are copied onto each
  entry in `plugins` before upload, and all entries deploy together, sharing one running
  container. The legacy flat single-object shape is still accepted.
- If every entry's `manifest.proxy_config` is set (MCP proxy plugins - see `aivin mcp create`
  below), no files are read or sent at all - just the manifest.
- `package-lock.json` is auto-generated (`npm install --package-lock-only`) before upload if missing
  - the backend's build runs `npm ci`, which requires one.
- On success, auto-increments `manifest.json`'s patch version(s) and writes back the plugin id(s)
  the server assigned.

```bash
aivin deploy
```

## `aivin test`

Same payload/logic as `aivin deploy`, but against `POST /plugins/test/deploy` - a non-production
instance for verifying the plugin runs end-to-end on real infra (real container, real gRPC, real
the SDK) before anyone else can see it. This endpoint is blocked by the backend in production.

After a successful deploy, it also **smoke-tests** every plugin entry: generates sample input from
`manifest.json`'s `input` schema (`POST /code/generate-sample-data`), invokes the plugin for real
(`POST /plugins/execute`) against a workspace, and writes a pass/fail report to
`.test/<timestamp>.json` in the project directory (also excluded from future deploy uploads).

```
Options:
  --workspace <id>  Workspace id to run the smoke test against (default: auto-picks your first one)
  --no-smoke-test   Only deploy - skip the generated-input invoke test and report
```

```bash
aivin test                        # deploy + smoke-test + report
aivin test --workspace <id>        # smoke-test against a specific workspace
aivin test --no-smoke-test         # deploy only, same as before this flag existed
```

## `aivin plugin make <description>`

AI-generates `src/main.ts` from a natural-language description, via the real `POST /code/generate`
endpoint (the same one the browser CodeEditor uses) - prompted to reinforce this SDK's conventions
(`main(mission, input, ctx)`, `import { ai } from '@aivin-labs/sdk'`, `PluginResponse`).
Requires `manifest.json` to already exist (`aivin create` first).

```
Options:
  --model <model>        LLM model to use for generation
  --provider <provider>  LLM provider to use for generation
```

```bash
aivin plugin make "Summarize a support ticket and tag its urgency"
```

Review generated code before relying on it - it's a strong starting point, not a guarantee.

## `aivin plugin convert [hint]`

Same generator as `plugin make`, pointed at code you already have instead of a description. Reads
the current directory as context and asks the AI to adapt its existing logic into `src/main.ts`,
preserving behavior rather than stubbing it out.

```
Options:
  --model <model>        LLM model to use for generation
  --provider <provider>  LLM provider to use for generation
```

- No `manifest.json` needed first - if one doesn't exist, it's created from `package.json` (name,
  description) or the directory name.
- Fails if `src/main.ts` already exists - this is for a project that isn't a plugin yet, not for
  editing one.
- Gathers the project's own files as AI context (same exclusions as `aivin deploy` - `node_modules/`,
  `.git/`, lockfiles, etc. - plus a size cap per file and in total; large binary-ish files are
  skipped). `src/main.ts`/`manifest.json` themselves are never included, since a `workspace_files`
  entry for the file being generated is what would trip the backend's surgical-edit/diff mode.
- `[hint]` is optional extra guidance, e.g. which function to focus on.

```bash
cd your-existing-project
aivin plugin convert
aivin plugin convert "focus on the exportInvoice function"
```

Review generated code before relying on it - it's a strong starting point, not a guarantee.

## `aivin plugin search <query>`

Searches the platform's plugin ecosystem before you write new logic - the same relevance-ranked
lookup the platform's own agent uses to auto-select a plugin for a mission (`GET /plugins/search`).
Doesn't need to be run from inside a plugin project.

```bash
aivin plugin search "send a slack message"
```

Options:

```
Options:
  --workspace <id>  Restrict to plugins visible in this workspace (default: your whole org)
  --limit <n>       Max results to show
```

Prints each match's id, name, description, and version. Call one from your own plugin with
`import { call } from '@aivin-labs/sdk'` then `await call('<id>.<purpose>', params)`.

## `aivin plugin trigger [mission] [input]`

Invokes an **already-deployed** plugin for real and prints the result - the same
`POST /plugins/execute` the platform's own Playground ("Thử nghiệm" tab) uses, so it exercises the
exact same code path a running agent would hit. Run it from the plugin's project directory -
`manifest.json` supplies the plugin id (`--func <name>` picks the entry for a multi-function
plugin).

```
Options:
  -a, --auto <prompt>  Natural-language prompt - the platform auto-maps it onto
                       the input schema for you
  --func <name>        Which function to trigger, for a multi-function plugin
                       (matches name/func/id)
  --workspace <id>     Workspace id to run against (default: auto-picks your
                       first one)
  --agent <id>         Agent id to run as, if the plugin needs one for
                       HIL/confirm behavior to be accurate
```

**Direct mode** - `<mission>` (becomes `main()`'s `mission` argument) and `<input>` (a JSON string,
becomes `main()`'s `input` argument) both required:

```bash
aivin plugin trigger "summarize this" '{"text":"Aivin plugins are easy to write."}'
```

**Auto mode** (`-a`/`--auto <prompt>`) - give it free text instead of structured JSON; the backend's
own input-mapping (`mapDataToSchema`, the same mechanism the Playground's chat-style tester uses)
maps it onto `manifest.json`'s `input` schema for you:

```bash
aivin plugin trigger -a "Summarize this ticket: customer can't log in after the last update"
```

`<input>` can still be given alongside `-a` for fields you want to force rather than let the AI
infer - explicit values win over auto-mapped ones per field.

What gets printed:
- `--- Log ---` - the backend's own mapping/execution stage messages (`processing_log`), if any.
  This is **not** your plugin's own `console.log()` output from inside `main.ts` - it's everything
  the HTTP response itself carries, printed after the call completes. Run `aivin plugin logs` in
  another terminal first if you want to watch your plugin's own console output live while this runs.
- `--- Auto-mapped input ---` - what `-a`'s prompt actually got mapped to (`mapped_arguments`),
  only present in auto mode.
- `--- Result: <status> ---` - the plugin's real `status`/`message`/`error_code`/`data`.

## `aivin plugin logs [pluginId]`

Tails an **already-deployed** plugin's own container stdout/stderr live - the same real-time feed
the platform's own Playground log panel uses. `pluginId` defaults to the current directory's
`manifest.json` id (`--func <name>` picks the entry for a multi-function plugin), so plain
`aivin plugin logs` works from inside the plugin's own project directory; pass an explicit id to
watch a plugin you're not standing inside.

```
Options:
  --func <name>   Which function's id to resolve, for a multi-function plugin
                  (only used when pluginId is omitted)
```

```bash
aivin plugin logs
aivin plugin logs my-plugin-id
```

Prints each line as it's written (`console.log` → gray, `console.error` → red), with a local
timestamp. Runs until you press Ctrl+C. If the container restarts (redeploy/crash) mid-stream,
the connection ends - re-run the command to resume watching.

## `aivin mcp create <name>`

Scaffolds a **manifest-only** plugin (`proxy_config.type: "mcp"`) that proxies straight to an
external [MCP](https://modelcontextprotocol.io) server's tool/resource/prompt - no `src/main.ts`,
no `package.json`, nothing to run. `aivin deploy`/`aivin test` detect this automatically.

```
Options:
  --transport <transport>      stdio | sse
  --command <command>          Command to launch the MCP server (stdio transport)
  --args <args>                Space-separated args for --command (stdio transport)
  --url <url>                  Remote MCP server URL (sse transport)
  --kind <kind>                tool | resource | prompt (default: tool)
  --tool-name <name>           MCP tool name (kind=tool)
  --resource-uri <uri>         MCP resource URI (kind=resource)
  --resource-mime-type <mime>  MIME type of the resource (kind=resource)
  --prompt-name <name>         MCP prompt name (kind=prompt)
  --description <description>  Plugin description
  --auth-secret-key <key>      Name of the workspace secret to use as the Bearer
                               token, if the MCP server needs auth
```

- No `--command`/`--url` → interactive prompts for everything.
- `--command`/`--url` given → fully non-interactive/scriptable. `--transport` and `--kind` are
  inferred from whichever flags you pass (`--command` implies stdio, `--url` implies sse;
  `--tool-name`/`--resource-uri`/`--prompt-name` each imply their own `--kind`) - spell them out
  explicitly only if you're scripting this without any of those (unusual).

```bash
# stdio (local command)
aivin mcp create fs-tools --command npx --args "-y @modelcontextprotocol/server-filesystem /data" \
  --tool-name read_file --description "Read files via MCP"

# sse (remote server)
aivin mcp create doc-search --url https://example.com/mcp \
  --tool-name search_docs --description "Search external docs via MCP"
```

See [MANIFEST.md#mcp-proxy-plugins](./MANIFEST.md#mcp-proxy-plugins) for the full `proxy_config`
field reference.

## `aivin login`

Saves an API key **once, machine-wide**, to `~/.aivin/credentials` - not the current project's
`.env`. Logging in is a per-machine thing, not a per-project one, so you only need to run this once
regardless of how many plugin projects you work in - every project's `deploy`/`test`/`plugin make`
picks it up automatically.

```
Options:
  -k, --api-key <key>  Set API key directly (skip login entirely)
  --basic              Log in with email/password directly in the terminal instead of a browser
  --google             Alias of the default browser flow - pick Google once the page opens
  --client <client>    Client/org id to use with --basic (default: "aivin.cloud")
```

**Default (no flags) - browser flow, recommended:**

```bash
aivin login
```

Opens your default browser to the platform's actual login page (`https://brain.aivin.cloud`) with
a one-time state token and a `localhost` callback URL. Log in exactly the way you normally would in the
browser - custom-domain org, password, Google, OTP, whatever applies to your account. Once you
confirm on the "Aivin CLI wants to create an API Key" prompt that appears after login, a fresh key
is minted (named after this machine's hostname, replacing any previous key with that same name) and
handed back to a tiny local HTTP server the CLI started for this one request, then saved to
`~/.aivin/credentials`. The browser tab never shows you the raw key - only the CLI does.

`--google` doesn't change anything technically; it's just documentation that once the page opens
you can pick "Log in with Google" there, same as any other login on that page.

**`--basic` - no browser, terminal-only:**

```bash
aivin login --basic
```

Prompts for email/password directly and logs in against the default/shared client only (`--client`,
falls back to `"aivin.cloud"`). If your account belongs to a custom-domain organization, this won't
resolve that domain for you - use the default browser flow instead, which handles it the same way
the web login page does.

**Already have a key:**

```bash
aivin login --api-key <key>
```

Skips login entirely - just saves the given key to `~/.aivin/credentials`.

## Environment variables

`aivin login` saves your key once to `~/.aivin/credentials` and every plugin project on the
machine picks it up automatically - there's no per-project credential to manage.

| Variable            | Used by                                          | Default                     | When you'd touch it                                          |
| -------------------- | -------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| `SDK_GRPC_ENDPOINT`  | SDK calls, `aivin start`                   | `api.aivin.cloud:50051`      | Point `main()`'s SDK calls at a local/dev backend instead of production. |
| `AIVIN_BASE_URL`     | `deploy`, `test`, `plugin make/convert/trigger`, `login --basic` | `https://api.aivin.cloud`    | Only for a self-hosted or staging instance.                   |
| `AIVIN_WEB_URL`      | `login` (browser flow)                             | `https://brain.aivin.cloud`  | Only for a self-hosted or staging instance.                   |
| `LOCAL_TEST_PORT`    | `aivin start`                                       | `4001`                       | Only if `4001` is already taken on your machine.              |

Everything else (`SDK_GRPC_SECRET`, `SDK_GRPC_SERVER_BIND`, `SDK_GRPC_TLS`, `NODE_ENV`, ...) is
either injected automatically inside a deployed container or has a working zero-config default -
not something you're expected to set by hand.

## See also

- [MANIFEST.md](./MANIFEST.md) - every `manifest.json` field, including MCP proxy plugins
- [PLUGIN_DEVELOPMENT_GUIDE.md](./PLUGIN_DEVELOPMENT_GUIDE.md) - end-to-end walkthrough using these commands
- [SDK.md](./SDK.md) - everything the SDK exposes inside `main()`
