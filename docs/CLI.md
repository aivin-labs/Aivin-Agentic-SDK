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
  connector                Register and discover reusable connectors (OAuth
                           apps / credential-form namespaces)
  mcp                      MCP proxy plugins - wrap an external MCP server
                           tool/resource/prompt, no code required
  login [options]          Log in and save an API key for plugin deployment
                           (opens your browser by default)
  key                      Manage named API keys for your account
  do [options] [agentNickname] [mission]  Have <agentNickname> work toward a
                           goal in the background - not a specific deployed
                           plugin
  task [options] [description]  Create a new task from a plain-language
                           description
  workspace [options]      Browse your workspaces and projects, and pick one to
                           use with --workspace/--project
  agent                    Search, install, create, and publish AI Staff agents
  project                  Create, update, and delete projects within a
                           workspace
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

AI-generates a plugin from a natural-language description, via `POST /code/generate-project` -
**complexity-adaptive**: the backend classifies the requirement first, and only escalates beyond a
single `src/main.ts` when it's genuinely complex.

```
Options:
  --model <model>        LLM model to use for generation
  --provider <provider>  LLM provider to use for generation
```

```bash
aivin plugin make "Summarize a support ticket and tag its urgency"
```

- **Simple/moderate** requirement (the common case): exactly one `src/main.ts`, one generation call
  - unchanged from before. Same conventions as always (`main(mission, input, ctx)`,
  `import { ai } from '@aivin-labs/sdk'`, `PluginResponse`).
- **Complex** requirement (several genuinely independent capabilities, or logic too large for one
  flat function): the backend plans a small multi-file project first, generates each file, and - if
  the plan calls for it - returns a [multi-function manifest](./MANIFEST.md#multi-function-plugins)
  fragment that replaces `manifest.json`'s `plugins[]` with one entry per capability.

Requires `manifest.json` to already exist (`aivin create` first).

### Self-correction loop

Generation isn't one-shot, and for a multi-file plan it isn't one-file-at-a-time either: files with
no dependency on each other generate in parallel (only a file that genuinely needs to see another
one's content, per the plan's own `depends_on`, waits for it first). After writing every returned
file, if the project's own `typescript` devDependency is installed (`npm install` already run), the
whole project is type-checked with `tsc --noEmit`. Real compiler errors (exact
`file(line,col): error TSxxxx: ...` lines) are attributed back to whichever file they were reported
against and sent to the AI for a surgical fix - up to 2 rounds, across as many files as had errors:

```
🤖 Generating plugin
✅ 2 file(s) generated (src/main.ts, src/lib/search.ts)
⚠️  2 compiler error(s) across 1 file(s) - asking the AI to fix...
✅ Fixed - clean type-check after 1 attempt(s)
```

If `node_modules` isn't installed yet, type-checking (and the self-correction it enables) is skipped
silently - run `npm install` first if you want it. If errors remain after both rounds, every file is
still written, with every remaining error printed for you to fix by hand.

Review generated code before relying on it either way - self-correction only catches what `tsc`
catches (type errors), not wrong business logic.

## `aivin plugin convert [hint]`

Hands the existing project in the current directory to the backend's agentic project-conversion
pipeline instead of generating locally. Unlike `plugin make`/`plugin init` (a single AI call per
file, run entirely from what you pass it), this command:

1. Uploads only the **directory tree** - paths and byte sizes, never file content - so the request
   stays cheap no matter how large the project is.
2. The backend scans it: it decides which files are actually worth reading (entry points,
   `package.json`, anything name-suggestive of routes/tools/skills) and asks the CLI to read them
   back one at a time, over the same socket connection `aivin plugin logs` uses.
3. It plans a conversion - single `main()` vs. a [multi-function manifest](./MANIFEST.md#multi-function-plugins)
   (one `plugins[]` entry per independent capability), and which files to create vs. adapt in
   place - detecting the project's shape (a plain script, an MCP server, an API backend with
   routes, a Claude-style skill) from what it actually read, not a fixed regex. If the project isn't
   TypeScript/JavaScript (Python, Go, ...), every file becomes a **port** (translated, not edited) -
   the plan always uses `create` in that case, never `update`, since there's no existing `.ts` file
   to adapt in place.
4. It generates/updates each planned file, then **verifies with a real `tsc --noEmit` run** on your
   machine (via the same tool-call channel) and self-corrects on real compiler errors, up to twice.

Every step prints live as it happens - this loop can take a while on a real project, so it's never
silent:

```bash
cd your-existing-project
aivin plugin convert
# 📂 Scanning project tree...
#    142 file(s) in tree (content read on demand by the server, never uploaded up front)
# 🤖 Converting - this loops (scan → plan → generate → verify), watch for progress below...
#
# [10:32:01] Scanning project tree (142 entries)...
# [10:32:03] Reading 3 file(s): package.json, src/index.ts, src/tools/search.ts
# [10:32:07] Plan ready: mcp_server, 2 file(s) - Two independent MCP tools found (search, fetch);
#            splitting into a multi-function manifest so each is separately callable.
# [10:32:15] Generating 2 file(s) in parallel: src/main.ts, src/lib/search.ts
# [10:32:22] Type-checking (attempt 1)...
# [10:32:23] Type-check clean
# [10:32:23] All required exports present
# [10:32:24] Running a smoke test with generated sample input (may make real SDK/AI calls using your credentials)...
# [10:32:31] Smoke test passed
# ✅ Conversion done (mcp_server, 2 file(s))
```

The smoke test only runs if the type-check passed first (no point executing code that doesn't even
compile) and `@aivin-labs/sdk` is already installed locally (`npm install`) - skipped, not failed,
otherwise. It spawns the real plugin runtime on your machine on off-default ports (won't collide with
a real `aivin start`) with AI-generated sample input, so a plugin whose logic calls `ai.prompt()` or
other SDK methods will make a real call using your credentials during this step.

```
Options:
  --model <model>        LLM model to use for generation
  --provider <provider>  LLM provider to use for generation
  --force                 Re-run conversion even if src/main.ts already exists (e.g. redo a
                          previous bad/stale result)
```

- No `manifest.json` needed first - if one doesn't exist, it's created from `package.json` (name,
  description) or the directory name.
- Fails if `src/main.ts` already exists, unless `--force` is given - the plain (no-flag) case is
  for a project that isn't a plugin yet; `--force` re-runs the whole scan/plan/generate/verify loop
  against a project this command already converted before (the earlier plan turned out wrong, the
  project changed since, whatever the reason) - `src/main.ts` isn't excluded from what gets scanned,
  so the new plan is free to mark it `update`, and the usual per-file overwrite confirmation still
  applies to it like any other existing file.
- `[hint]` is optional extra guidance, e.g. which function to focus on - passed straight to the
  backend's planning step.
- If the plan is multi-function, `manifest.json`'s `plugins[]` is replaced with one entry per
  planned capability (fresh local ids - `aivin deploy` still assigns the real ones).
- Requires a live connection to the Aivin server for the whole duration (it's not a local batch
  job) - the socket is what lets the backend read files on demand and stream progress back.
- Only one conversion can run at a time per project - starting a second one against the same
  project while the first is still running fails fast instead of racing both against the same
  files. If the previous run's process died without cleanly finishing, this frees up on its own
  within moments, not stuck for the full run duration.
- The whole run gives up after ~15 minutes regardless of how far it got, so a stuck step can't hold
  the connection open forever.

### Overwrite safety

Unlike `plugin make`, this command can touch files that **already exist** in your project - the
backend's plan may mark some as `update` (adapt in place) rather than `create` (new file):

- Before scanning starts, if the directory is a git repo with uncommitted changes, you're warned
  and (in an interactive terminal) asked to confirm before continuing at all.
- Before any individual existing file is actually overwritten, you're prompted per-file (with a
  quick `git status` hint - untracked vs. has uncommitted changes - when available) - declining
  skips just that file, the rest of the conversion continues.
- Non-interactive runs (CI/scripts) can't prompt, so they proceed automatically - the decision is
  still printed to the log either way, it's just not blocking.

Review the generated code before relying on it - self-correction only catches what `tsc` catches
(type errors), not wrong business logic, and the file/project-kind detection is a best effort, not
a guarantee.

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
  --plain           Print a flat list instead of the interactive browser (for scripts/CI)
```

In a real terminal, results open in an interactive browser: `↑`/`↓` to move between matches,
`space`/`enter` to open a plugin's detail view (full description, version, input/output schema),
`esc`/`backspace` to go back to the list, `q` to quit. Non-TTY contexts (scripts, CI, piped
output) or `--plain` fall back to a flat printed list.

Call one from your own plugin with `import { call } from '@aivin-labs/sdk'` then
`await call('<plugin_id>', params)`.

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

## `aivin key`

Manages *named* API keys on your account - separate from the one machine-wide key `aivin login`
saves. Useful for giving a CI pipeline, a teammate's script, or any other caller its own key you can
revoke independently later.

```
Commands:
  gen [options] <name>     Create (or replace) a named API key for your account - shown only once
  revoke [options] <name>  Revoke a named API key for your account
  list [options]           List API keys on your account
```

```bash
aivin key gen "ci-pipeline"         # prompts for your account password, prints the new key once
aivin key gen "ci-pipeline" --save  # also saves it to ~/.aivin/credentials as this machine's default
aivin key list                      # see what's on your account
aivin key revoke "ci-pipeline"      # revoke it by name
```

All three authenticate with the `API_KEY` `aivin login` already saved - no email/password prompt for
`list`/`revoke`. `gen` is the exception: it still asks for your **account password** (not email) as
a step-up check, since minting a new key from an existing one is the one action here that could
otherwise let an already-leaked key re-provision itself indefinitely even after you revoke it.
`list`/`revoke` only read or remove access, never grant it, so they need no such check.

`aivin key gen` replaces (not accumulates) any existing key with the same name, the same way
re-running `aivin login` replaces this machine's own key.

## `aivin do <agent_nickname> <mission>`

Has a specific agent start a background mission toward a free-text goal (`POST /agent/start-work`),
not a specific deployed plugin. The agent runs the mission on its own, checking in via the
progress stream (see below); this is the CLI-native equivalent of typing into the platform's chat
and choosing which AI Staff agent should handle it.

```
Options:
  --workspace <id>  Workspace id to run in (default: your personal workspace)
  --project <id>    Project id within the workspace
  --no-watch        Fire the mission and return immediately - skip streaming live progress
```

```bash
aivin do supportbot "Summarize today's support tickets and post the summary to #digest"
```

- `<agent_nickname>` is matched against the resolved workspace's already-installed agents (by
  nickname, name, or id). Omit either argument and you'll be prompted interactively - the mission
  prompt if only the agent is given, or a picker over the workspace's agents if only the mission is
  given (in a non-interactive shell, both are required up front).
- If the nickname doesn't match anything in the workspace, or the workspace has no agents at all
  yet, you're offered a choice: search & install one from the marketplace, or create a brand new
  one - so `aivin do` never dead-ends on an empty workspace (see `aivin agent install`/`aivin agent
  make` below, which this reuses).

By default it then streams the mission's live progress in the terminal (same realtime channel
`aivin plugin logs` uses under the hood) until the run finishes or you press Ctrl+C - pass
`--no-watch` to just fire it and return immediately instead.

If `--workspace` is omitted, it runs in your **personal workspace** (the platform always resolves
that first when no workspace is given).

### `aivin do job <description>`

Creates a new **automation job** - recurring background work on a cron-style schedule, independent
of any single chat/mission invocation (`POST /automation/jobs/create`).

```
Options:
  --workspace <id>      Workspace id to create the job in (default: your personal workspace)
  --project <id>        Project id within the workspace
  --agent <id>          Agent id the job runs as (default: the workspace's default agent)
  --schedule <condition>  Natural-language schedule, e.g. "every Monday at 9am" (default: let the
                         platform infer one)
```

```bash
aivin do job "Compile last week's support tickets into a summary and post it to #digest"
aivin do job "Send a daily standup reminder" --schedule "every weekday at 9am"
```

If `--schedule` is omitted, the platform infers a cadence (or falls back to manual) from the
description itself - pass it explicitly if you already know the cadence, to skip the extra
inference call.

## `aivin task [description]`

Creates a new task (`POST /task/create`) from a plain-language description - the description
becomes both the task's title (truncated if long) and its full content.

```
Options:
  --workspace <id>  Workspace id to create the task in (default: your personal workspace)
  --project <id>    Project id within the workspace
  --assignee <userId>  User id to assign the task to (default: unassigned)
```

```bash
aivin task "Follow up with the customer about their refund request"
```

`aivin task` also has subcommands for the rest of the task lifecycle:

```
Commands:
  list [options]          List tasks in a project
  mine [options]          List tasks assigned to you in a project
  get [id]                Get a task by id
  update [options] [id]   Update a task
  delete [id]             Delete a task
```

```bash
aivin task list --status todo                          # list open tasks in your first project
aivin task list --project <id> --assignee <userId>      # filter by project/assignee
aivin task mine                                          # tasks assigned to you
aivin task get <id>                                      # full task details (JSON)
aivin task update <id> --status done                     # move a task to done
aivin task update <id> --title "New title" --priority high
aivin task delete <id>
```

`list`/`mine` are scoped to a single project (the backend's real `/task/:projectId/list` route) -
`--project` defaults to the resolved workspace's first project, and throws if it has none (a
Personal workspace typically has no projects; pass `--project <id>` explicitly, or run
`aivin workspace` to find one).

## `aivin workspace`

Interactive picker: lists your workspaces (personal workspace first), lets you select one, then
lists that workspace's projects so you can pick the corresponding one - printing the resolved
`--workspace`/`--project` ids to pass to `aivin do`/`do job`/`task`.

```
Options:
  --plain  Print a flat list instead of the interactive picker (for scripts/CI)
```

```bash
aivin workspace
```

Non-TTY contexts (scripts, CI, piped output) or `--plain` print a flat listing instead of the
interactive prompts.

## `aivin agent`

Search the AI Staff marketplace, install an agent into a workspace, create a brand new one, or
publish one you own. `aivin do` calls into the same install/create flows automatically when it
can't resolve `<agent_nickname>`.

```
Commands:
  search [options] [query]     Search the AI Staff marketplace for an agent
  install [options] [query]    Search the marketplace and install an agent into a workspace
  make [options]                Create a brand new AI Staff agent
  publish [options] [agentId]  Publish an agent you own to the marketplace
```

```bash
aivin agent search "customer support"                    # browse the marketplace
aivin agent install "customer support"                    # search + pick + install into your personal workspace
aivin agent install --workspace <id>                      # no query - opens the same interactive picker `aivin do` uses
aivin agent make --name "Ada" --nickname ada --email ada@example.com --bio "Support triage bot"
aivin agent publish <agentId>                             # make an agent you own visible in the marketplace
```

- `install`/`make` default to your personal workspace when `--workspace` is omitted.
- `make` calls `POST /ai-staff/create`; passing the target workspace at creation time auto-installs
  the new agent there too (no separate `install` call needed).
- `publish` is a two-step platform operation under the hood (`POST /ai-staff/update` with
  `is_published: true`, then `POST /ai-staff/push` to promote the workspace's local copy to the
  shared master) - both scoped to the workspace the agent actually lives/was authored in.

## `aivin project`

Create, rename, or delete a project within a workspace (the backend has no separate "list projects"
endpoint - use `aivin workspace` to browse a workspace's existing projects).

```
Commands:
  create [options] [name]  Create a new project in a workspace
  update [options] [id]    Update a project (currently: rename)
  delete [options] [id]    Delete a project
```

```bash
aivin project create "Q3 Launch"
aivin project update <id> --name "Q3 Launch (renamed)"
aivin project delete <id>
```

All three default to your personal workspace when `--workspace` is omitted.

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
