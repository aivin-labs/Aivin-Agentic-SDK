#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { spawn, exec, execSync, execFileSync } from 'child_process';
import axios from 'axios';
import http from 'http';
import os from 'os';
import dotenv from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';
import { randomBytes, createHash, randomUUID } from 'crypto';
import WSClient from 'ws';
import { io } from 'socket.io-client';
import readline from 'readline';
// Same flatten logic PluginServer.ts uses for local/production runtime resolution - imported from
// the built output (not src/) so deploy and runtime agree on exactly the same rules for what
// manifest.json's { ...commonFields, plugins: [...] } authoring shape expands into.
import { flattenManifestFile } from '../dist/types/PluginTypes.js';

// `~/.aivin/credentials` - written once by `aivin login [baseUrl]`, read by every plugin project
// on this machine. One ACTIVE context at a time (base_url + api_key together, like `kubectl config
// use-context`) - not a per-project setting, and not a multi-server map either. Logging into a
// different server (`aivin login beta-api.aivin.vn`) simply replaces the active context outright;
// every project on the machine picks up wherever you last logged in, with zero `.env` needed for
// the common case. A project's own `.env` can still set AIVIN_BASE_URL/API_KEY directly to pin
// itself to something other than the machine's current context (e.g. CI using a fixed scoped key)
// - dotenv.config() never overrides a variable that's already set, so that always wins.
//
// Old files from before this existed were flat `API_KEY=...` (implicitly production) - still loads
// fine, just with no recorded base_url (falls back to the production default below).
const GLOBAL_CREDENTIALS_PATH = path.join(os.homedir(), '.aivin', 'credentials');
const DEFAULT_AIVIN_BASE_URL = 'https://api.aivin.cloud';

/**
 * The REST API and the gRPC SDK channel are two different hostnames behind the same login (e.g.
 * `api.aivin.cloud` / `sdk.aivin.cloud` in production, `beta-api.aivin.vn` / `beta-sdk.aivin.vn` in
 * staging - proven consistent across both real environments this SDK talks to). Derived once at
 * login time by swapping the leading `api.` label for `sdk.`, so `SDK_ENDPOINT` never needs its own
 * separate manual config for the common case - same context, same command.
 */
function deriveSdkEndpoint(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    // Match "api." as its own label, whether at the very start ("api.aivin.cloud") or after a
    // prefix like "beta-" ("beta-api.aivin.vn" -> "beta-sdk.aivin.vn") - a plain `^api\.` anchor
    // only caught the production case and silently produced no SDK_ENDPOINT for staging.
    if (!/(^|-)api\./.test(host)) return null;
    return host.replace(/(^|-)api\./, '$1sdk.');
  } catch {
    return null;
  }
}

/**
 * No guessing/hardcoded map - the backend already knows its own web app URL (`config/app.json`'s
 * `app_url`, admin-tunable via ConfigIO, same value every branded page/asset link on that instance
 * already uses) and serves it through `GET /setting/lang/default`, a public route (no auth) meant
 * for exactly this: reading branding/config before a session exists. Each real backend (production,
 * staging, self-hosted) already has this correct for itself - a hardcoded CLI-side map would just
 * be a second, driftable copy of the same fact.
 */
async function fetchWebUrl(baseUrl) {
  try {
    const res = await axios.get(`${baseUrl}/setting/lang/default`, { timeout: 5000 });
    const appUrl = res.data?.app_url;
    return typeof appUrl === 'string' && appUrl ? appUrl : null;
  } catch {
    return null;
  }
}

/**
 * JSON-only, no legacy flat `API_KEY=...` dotenv-format fallback - a hard cutover, by request.
 * Anyone with an old-format credentials file just needs to `aivin login` again; this stays simple
 * instead of carrying a permanent "read either shape" branch for a one-time migration.
 */
function loadActiveContext() {
  if (!fs.existsSync(GLOBAL_CREDENTIALS_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(GLOBAL_CREDENTIALS_PATH, 'utf8'));
    if (!parsed?.api_key) return null;
    const base_url = parsed.base_url || DEFAULT_AIVIN_BASE_URL;
    return { base_url, api_key: parsed.api_key, sdk_endpoint: parsed.sdk_endpoint || deriveSdkEndpoint(base_url) };
  } catch {
    return null;
  }
}

function saveActiveContext(baseUrl, apiKey) {
  fs.mkdirSync(path.dirname(GLOBAL_CREDENTIALS_PATH), { recursive: true });
  const sdkEndpoint = deriveSdkEndpoint(baseUrl);
  fs.writeFileSync(
    GLOBAL_CREDENTIALS_PATH,
    JSON.stringify({ base_url: baseUrl, api_key: apiKey, sdk_endpoint: sdkEndpoint }, null, 2) + '\n',
    { mode: 0o600 },
  );
  return sdkEndpoint;
}

// Load env vars: the current project's `.env` first (any deliberate per-project override), THEN
// fill in AIVIN_BASE_URL/API_KEY/SDK_ENDPOINT from the machine's active context if the project
// didn't set them. `dotenv.config()` never overrides a variable that's already set, so a project's
// own `.env` (or a real shell env var) always wins over the global context, exactly like before -
// but nothing requires a project to have a `.env` at all anymore for the common single-context case.
// `quiet: true` - otherwise dotenv prints an "injected env" tip line to stdout on every run, which
// would corrupt `--json-output` mode (meant for clean, parseable JSON on stdout).
dotenv.config({ quiet: true });
{
  const activeContext = loadActiveContext();
  if (activeContext) {
    if (!process.env.AIVIN_BASE_URL) process.env.AIVIN_BASE_URL = activeContext.base_url;
    if (!process.env.API_KEY) process.env.API_KEY = activeContext.api_key;
    if (!process.env.SDK_ENDPOINT && activeContext.sdk_endpoint) process.env.SDK_ENDPOINT = activeContext.sdk_endpoint;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Single source of truth for "what version of @aivin-labs/sdk is this" - both the CLI's own
// `--version` output and the exact pin `createPackageJson()` writes into new scaffolds read from
// here, so they can never drift apart again (previously two separate hardcoded '1.2.0' literals
// - one in `.version()` below, one in the scaffold's `dependencies` - fell out of sync with the
// actual published npm version, breaking every fresh `npm install` with ETARGET).
const SDK_PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const SDK_VERSION = SDK_PACKAGE_JSON.version;

/**
 * `aivin start` spawns `node server.mjs`, which loads the plugin's own `src/main.ts` directly via
 * Node's native TS execution (no separate compile step) - the same mechanism this package's own
 * `engines.node` field (">=22.0.0") documents as required. Node <22 doesn't strip TS types at all,
 * so that failure doesn't surface as anything about Node versions - it's a raw loader error
 * ("Unknown file extension \".ts\"") thrown from deep inside `server.mjs`, giving no hint that the
 * fix is just "use a newer Node". Check the constraint up front instead, once, with a message that
 * says exactly what's wrong and how to fix it.
 */
function checkNodeVersion() {
  const required = SDK_PACKAGE_JSON.engines?.node;
  const requiredMajor = required && parseInt(required.match(/(\d+)/)?.[1], 10);
  const currentMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (requiredMajor && currentMajor < requiredMajor) {
    console.error(
      chalk.red(`❌ Node ${process.version} detected - @aivin-labs/sdk requires Node ${required} (native TypeScript execution).`),
    );
    console.error(chalk.gray(`   Switch versions (e.g. \`nvm use ${requiredMajor}\`) and try again.`));
    process.exit(1);
  }
}

const program = new Command();

program.name('aivin').description('Aivin Plugin SDK - Build and run AI plugins').version(SDK_VERSION);

// Command: create plugin
program
  .command('create [name]')
  .description('Create new plugin')
  .option('--json <config>', 'JSON config (AI mode)')
  .option('--stdin', 'Read from stdin')
  .option('--name <name>', 'Plugin name (if not specified, will prompt)')
  .option('--silent', 'Silent mode')
  .option('--json-output', 'JSON output')
  .action(async (name, options) => {
    if (name) options.name = name;
    try {
      let result;

      if (options.stdin) {
        const stdinData = await readStdin();
        result = await createFromJSON(stdinData, options);
      } else if (options.json) {
        result = await createFromJSON(options.json, options);
      } else {
        result = await createInteractive(options);
      }

      if (options.jsonOutput && result) {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      if (options.jsonOutput) {
        console.log(
          JSON.stringify(
            {
              success: false,
              error: error.message,
              code: error.code || 'ERROR',
            },
            null,
            2,
          ),
        );
      } else if (!options.silent) {
        console.error(chalk.red('❌'), error.message);
      }
      process.exit(1);
    }
  });

// Command: init plugin - guided one-step replacement for `create` + `plugin make`
program
  .command('init [name]')
  .description('Set up a new plugin step by step: asks what it should do, then generates real working code from that description')
  .option('--name <name>', 'Plugin name (if not specified, will prompt)')
  .option('--model <model>', 'LLM model to use for generation')
  .option('--provider <provider>', 'LLM provider to use for generation')
  .action(async (name, options) => {
    if (name) options.name = name;
    try {
      await initInteractive(options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}

// AI-friendly JSON mode
async function createFromJSON(jsonConfig, options) {
  try {
    let config;

    if (typeof jsonConfig === 'string') {
      try {
        config = JSON.parse(jsonConfig);
      } catch (parseError) {
        if (fs.existsSync(jsonConfig)) {
          config = JSON.parse(fs.readFileSync(jsonConfig, 'utf8'));
        } else {
          throw new Error('Invalid JSON: ' + parseError.message, { cause: parseError });
        }
      }
    } else {
      config = jsonConfig;
    }

    const validationResult = validatePluginConfig(config);
    if (!validationResult.valid) {
      throw new Error(`Validation failed: ${validationResult.errors.join(', ')}`);
    }

    const pluginDir = path.join(process.cwd(), options.outputDir || '', config.name);

    if (fs.existsSync(pluginDir) && !config.overwrite) {
      throw new Error(`Directory exists: ${pluginDir}`);
    }

    if (!options.silent) {
      console.log(chalk.blue('🤖 Creating plugin:'), config.name);
    }

    await createPluginProject(pluginDir, config.name, config.description || 'AI plugin', config);

    if (!options.silent) {
      console.log(chalk.green('✅ Created:'), pluginDir);
      console.log(chalk.cyan('\n🔧 Next steps:'));
      console.log(`   cd ${path.relative(process.cwd(), pluginDir)}  # Enter the new project directory`);
      console.log(`   npm install     # Install dependencies`);
      console.log(`   npm start       # Start plugin (local gRPC server + HTTP test shim)`);
    }

    return {
      success: true,
      pluginDir,
      name: config.name,
      description: config.description,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    if (!options.silent) {
      console.error(chalk.red('❌'), error.message);
    }
    throw error;
  }
}

// Config validation
function validatePluginConfig(config) {
  const errors = [];

  if (!config.name) {
    errors.push('Missing name');
  } else if (!/^[a-z0-9-]+$/.test(config.name)) {
    errors.push('Invalid name format');
  }

  if (!config.description) {
    errors.push('Missing description');
  }

  if (config.proxy_config?.type === 'mcp') {
    errors.push(...validateMcpProxyConfig(config.proxy_config).map((e) => `proxy_config.${e}`));
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Matches the backend's McpProxyConfig (src/plugins/dto/proxy/McpProxyConfig.ts): which fields
 * are required depends on `mcp_transport` (stdio needs a command, sse needs a url) and on
 * `mcp_kind` (tool/resource/prompt each point at a different identifying field).
 */
function validateMcpProxyConfig(proxyConfig) {
  const errors = [];

  if (proxyConfig.mcp_transport === 'stdio') {
    if (!proxyConfig.mcp_command) errors.push('mcp_command is required for stdio transport');
  } else if (proxyConfig.mcp_transport === 'sse') {
    if (!proxyConfig.mcp_url) errors.push('mcp_url is required for sse transport');
  } else {
    errors.push('mcp_transport must be "stdio" or "sse"');
  }

  const kind = proxyConfig.mcp_kind || 'tool';
  if (kind === 'tool' && !proxyConfig.mcp_tool_name) {
    errors.push('mcp_tool_name is required when mcp_kind is "tool"');
  } else if (kind === 'resource' && !proxyConfig.mcp_resource_uri) {
    errors.push('mcp_resource_uri is required when mcp_kind is "resource"');
  } else if (kind === 'prompt' && !proxyConfig.mcp_prompt_name) {
    errors.push('mcp_prompt_name is required when mcp_kind is "prompt"');
  }

  return errors;
}

// Command: Validate plugin config
program
  .command('validate')
  .description('Validate manifest.json in the current directory (or --json/--stdin for scripted use)')
  .option('--json <config>', 'JSON config, instead of reading manifest.json from the current directory')
  .option('--stdin', 'Read JSON config from stdin, instead of reading manifest.json')
  .option('--json-output', 'JSON output')
  .action(async (options) => {
    try {
      let configData;

      if (options.stdin) {
        configData = await readStdin();
      } else if (options.json) {
        configData = options.json;
      } else {
        // Simple, no-flags default: validate manifest.json in the current directory - the case
        // you actually want most of the time (`aivin validate` from inside your plugin project).
        // --json/--stdin remain for scripted/CI use where the config isn't a file on disk yet.
        const manifestPath = path.join(process.cwd(), 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
          throw new Error('No manifest.json found in the current directory. Pass --json <config> or --stdin instead.');
        }
        configData = fs.readFileSync(manifestPath, 'utf8');
      }

      // Expand the default { ...commonFields, plugins: [...] } shape and validate every entry -
      // flattenManifestFile itself throws on structural problems (empty plugins[], missing
      // id/name/func, bare top-level array).
      const config = flattenManifestFile(JSON.parse(configData));
      const entries = Array.isArray(config) ? config : [config];
      const errors = entries.flatMap((entry, i) =>
        validatePluginConfig(entry).errors.map((e) =>
          entries.length > 1 ? `plugins[${i}] (${entry.name || 'unnamed'}): ${e}` : e,
        ),
      );
      const result = { valid: errors.length === 0, errors };

      if (options.jsonOutput) {
        console.log(
          JSON.stringify(
            {
              valid: result.valid,
              errors: result.errors,
            },
            null,
            2,
          ),
        );
      } else {
        if (result.valid) {
          console.log(chalk.green('✅ Valid'));
        } else {
          console.log(chalk.red('❌ Invalid:'));
          result.errors.forEach((error) => console.log(`  • ${error}`));
        }
      }

      if (!result.valid) process.exit(1);
    } catch (error) {
      if (options.jsonOutput) {
        console.log(JSON.stringify({ valid: false, error: error.message }, null, 2));
      } else {
        console.error(chalk.red('❌'), error.message);
      }
      process.exit(1);
    }
  });

// Interactive mode
async function createInteractive(options) {
  console.log(chalk.blue('🚀 Aivin Plugin Creator\n'));

  // A name given upfront (positional arg or --name) means "scaffold a new project folder for me" -
  // matching `aivin mcp create <name>` and the --json/--stdin path below, both of which already
  // nest into a subdirectory named after the plugin. Without one, `aivin create` scaffolds into the
  // current directory - you've already mkdir'd/cd'd into your target folder yourself.
  const nameGivenUpfront = !!options.name;
  if (nameGivenUpfront && !/^[a-z0-9-]+$/.test(options.name)) {
    throw new Error('Plugin name must contain only lowercase letters, numbers, and hyphens');
  }
  const pluginDir = nameGivenUpfront ? path.join(process.cwd(), options.name) : process.cwd();

  if (nameGivenUpfront && fs.existsSync(pluginDir)) {
    throw new Error(`Directory already exists: ${pluginDir}`);
  }

  let pluginName = options.name;

  let currentPackageJson = null;
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  if (!nameGivenUpfront && fs.existsSync(packageJsonPath)) {
    currentPackageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    pluginName =
      pluginName ||
      currentPackageJson.name?.replace('@aivin/plugin-', '') ||
      path.basename(process.cwd());
  } else if (!nameGivenUpfront) {
    pluginName = pluginName || path.basename(process.cwd());
  }

  // A name given upfront (positional arg or --name) is used as-is, no re-prompt - the whole point
  // of providing it was to skip that question.
  const nameQuestion = nameGivenUpfront
    ? []
    : [
        {
          type: 'input',
          name: 'name',
          message: 'Plugin name:',
          default: pluginName,
          validate: (input) => {
            if (!input.trim()) return 'Plugin name cannot be empty';
            if (!/^[a-z0-9-]+$/.test(input))
              return 'Plugin name must contain only lowercase letters, numbers, and hyphens';
            return true;
          },
        },
      ];

  const answers = await inquirer.prompt([
    ...nameQuestion,
    {
      type: 'input',
      name: 'description',
      message: 'Plugin description:',
      default: currentPackageJson?.description || 'New Aivin plugin',
    },
  ]);

  pluginName = answers.name || pluginName;

  await createPluginProject(pluginDir, pluginName, answers.description, null, currentPackageJson);
  console.log(chalk.green(`\n✅ Plugin files created successfully!`));
  console.log(`📁 Directory: ${pluginDir}`);
  console.log(chalk.cyan(`\n🔧 Next steps:`));
  if (nameGivenUpfront) {
    console.log(`   cd ${pluginName}  # Enter the new project directory`);
  }
  console.log(`   npm install     # Install dependencies`);
  console.log(`   npm start       # Start plugin locally (gRPC server + HTTP test shim on :4001)`);
}

async function createPluginProject(
  pluginDir,
  name,
  description,
  aiConfig = null,
  currentPackageJson = null,
  { skipHandler = false } = {},
) {
  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true });
  }

  const tasks = [
    createManifest(pluginDir, name, description, aiConfig),
    createPackageJson(pluginDir, name, description, currentPackageJson),
    createTsConfig(pluginDir),
    createEnv(pluginDir),
    createGitignore(pluginDir),
    // `skipHandler` is only ever true for `aivin init`'s flow (see below) - the AGENTS.md content
    // differs depending on whether this project will end up with the src/service.ts split or one
    // plain src/main.ts, so it doubles as that signal here.
    createAgentsGuide(pluginDir, { usesServiceSplit: skipHandler }),
    createTestFile(pluginDir, { usesServiceSplit: skipHandler }),
  ];
  // `aivin init` writes its own src/main.ts (static wrapper) + src/service.ts (AI-generated business
  // logic) right after this returns - skip the generic placeholder handler so it isn't written and
  // immediately overwritten.
  if (!skipHandler) tasks.push(createHandler(pluginDir, aiConfig));
  await Promise.all(tasks);
}

/**
 * AGENTS.md - the emerging cross-tool convention (Claude Code, Cursor, and others all read this
 * file automatically on open, unlike docs/AI-Plugin-Guide.md in the *SDK's own* repo, which a
 * coding agent working inside a freshly-scaffolded plugin project - a completely different
 * directory - has no way to discover on its own). Kept short on purpose: this is a primer to get
 * an agent oriented fast, not a full reference - it points to the installed package's own README
 * for depth instead of duplicating it.
 */
async function createAgentsGuide(pluginDir, { usesServiceSplit = false } = {}) {
  const agentsPath = path.join(pluginDir, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) return;

  const filesSection = usesServiceSplit
    ? `## The files that matter

- **\`manifest.json\`** - shared fields (version/author) + a \`plugins: []\` array, one entry per exported function (the scaffold has one entry whose \`func\` points at \`main\`). Each entry's \`input\`/\`output\` field descriptions are used for auto-mapping natural-language prompts onto real args. Full reference: \`node_modules/@aivin-labs/sdk/docs/MANIFEST.md\`.
- **\`src/service.ts\`** - the actual business logic. Edit this. A single exported \`execute(input, ctx)\` that returns plain result data, or throws a plain \`Error\` on failure - no \`PluginResponse\`/\`PluginStatus\` to think about here.
- **\`src/main.ts\`** - a thin, static wrapper. Do NOT edit this or add logic to it - it just calls \`execute()\` and packages the result into the \`PluginResponse\` the platform expects. Its filename is fixed (the runtime always loads exactly this file), unlike \`service.ts\` which is just this project's convention.`
    : `## The two files that matter

- **\`manifest.json\`** - shared fields (version/author) + a \`plugins: []\` array, one entry per exported function (the scaffold has one entry whose \`func\` points at \`main\`). Each entry's \`input\`/\`output\` field descriptions are used for auto-mapping natural-language prompts onto real args. Full reference: \`node_modules/@aivin-labs/sdk/docs/MANIFEST.md\`.
- **\`src/main.ts\`** - exports exactly one \`main(mission, input, ctx)\` entry point, returning a \`PluginResponse\` (\`{ status: PluginStatus.SUCCESS | ERROR | FAIL, data?, message?, error_code? }\`).`;

  const regenerateCommand = usesServiceSplit
    ? `\`aivin plugin make "<description>"\` - regenerate \`src/service.ts\` from a plain-language description (detected automatically; \`src/main.ts\` is left untouched).`
    : `\`aivin plugin make "<description>"\` - regenerate \`src/main.ts\` from a plain-language description.`;

  const testFileName = usesServiceSplit ? 'test/service.test.ts' : 'test/main.test.ts';
  const testTargetName = usesServiceSplit ? 'execute()' : 'main()';

  const content = `# AGENTS.md

This is an Aivin plugin project (\`@aivin-labs/sdk\`). Quick orientation for a coding agent working in this directory.

${filesSection}

## Calling the platform - import what you need from \`@aivin-labs/sdk\`

**Always use this style** in any code you write or generate here:

\`\`\`typescript
import { ai } from '@aivin-labs/sdk';
import { PluginStatus } from '@aivin-labs/sdk';
import type { PluginInput, PluginContext, PluginResponse } from '@aivin-labs/sdk';

export async function main(mission: string, input: PluginInput, ctx: PluginContext): Promise<PluginResponse> {
  const summary = await ai.prompt(\`Summarize: \${input.text}\`);
  return { status: PluginStatus.SUCCESS, data: summary };
}
\`\`\`

\`ctx.sdk.*\` is the legacy mechanism - it still works (same client under the hood) but is NOT recommended; don't generate new code with it. Its one remaining niche: calling the platform from somewhere that isn't guaranteed to be inside a running \`main()\` invocation, where the top-level import's \`AsyncLocalStorage\` scoping doesn't reach.

Namespaces available: \`ai\`, \`knowledge\`, \`vector\`, \`datasource\`, \`causality\`, \`attachment\`, \`workspace\`, \`agent\`, \`browser\`, \`project\`, \`table\`, \`code\`, \`task\`, \`message\`, \`notification\`, \`realtime\`, \`queue\`, \`usage\`, \`automation\`, \`resource\`, \`session\`, \`file\`, \`setting\`, \`store\`, \`redis\`, \`mongo\`. Full per-namespace reference: \`node_modules/@aivin-labs/sdk/docs/sdk/*.md\`.

## Reusing another plugin instead of writing new logic

Before implementing something from scratch, check if a plugin already does it:

\`\`\`bash
aivin plugin search "what you're trying to do"
\`\`\`

Call one from your own \`main()\` with \`import { call } from '@aivin-labs/sdk'\` then \`await call('<plugin_id>.<purpose>', params)\`.

## Commands you'll actually use

- \`aivin start\` - run this plugin locally (gRPC server + HTTP test shim on :4001).
- \`aivin start --debug\` - same, plus logs every \`sdk.*\` call live as it happens (human-readable one-liner per call). \`--debug-json\` prints the same events as one JSON object per line instead - prefer this when *you* (the coding agent) are the one reading the output, so you can parse it instead of pattern-matching free text.
- \`npm test\` - runs \`${testFileName}\` (Node's built-in test runner + native TS execution, no extra tooling). Mocks the SDK with \`createMockSDK\`/\`withMockSDK\` from \`@aivin-labs/sdk\` - no real backend, no gRPC round trip. **Keep this file in sync whenever you change what \`${testTargetName}\` calls or returns** - update the mocked \`handlers\` and assertions together with the logic, don't let it go stale.
- \`aivin test\` - deploy to a *real* test instance and smoke-test it with generated input (unlike \`npm test\`, this hits the actual backend) - writes a JSON report to \`.test/\`, read that file for structured pass/fail instead of parsing the console output.
- \`aivin plugin trigger "<mission>" '<input JSON>'\` - invoke an already-deployed plugin for real.
- \`aivin plugin logs\` - tail this plugin's own console output live, once deployed.
- ${regenerateCommand}

## Debugging a failure

1. Reproduce locally first: \`aivin start --debug-json\`, then \`curl -X POST http://localhost:4001/invoke -H 'content-type: application/json' -d '{"input":{...}}'\` in another terminal (or read the JSON lines this process prints as it runs, if you're driving it directly).
2. Each \`sdk.*\` call's own error message is usually the fastest signal - namespaces validated with zod (\`automation.*\`, \`resource.*\`, \`store.*\`, \`table.*\`) throw \`[namespace.method] invalid params - field: reason\` immediately on a bad shape, before any network call.
3. If a call's *shape* is right but the *result* is wrong, check the relevant \`node_modules/@aivin-labs/sdk/docs/sdk/*.md\` page - several namespaces have "Notes & caveats" documenting real field names/behavior that differ from what you'd guess (e.g. \`automation.createJob\` takes \`mission\`/\`schedule_condition\`, not \`name\`/\`schedule\`).

Full docs: \`node_modules/@aivin-labs/sdk/README.md\` and \`node_modules/@aivin-labs/sdk/docs/\`.
`;
  fs.writeFileSync(agentsPath, content);
}

/**
 * A real, runnable example test using createMockSDK/withMockSDK/createMockContext - not just
 * documentation. Deliberately written to still PASS against the literal placeholder handler
 * `createHandler` writes (which calls no SDK method at all) - the mocked `ai.prompt` handler is
 * simply never invoked in that case, and the assertions on `status`/`data.processed` hold either
 * way. Once real logic replaces the placeholder (by hand or via `aivin plugin make`), this file is
 * a starting point to adapt, exactly like `src/main.ts`/`src/service.ts` themselves are.
 */
async function createTestFile(pluginDir, { usesServiceSplit = false } = {}) {
  const testDir = path.join(pluginDir, 'test');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

  const testPath = path.join(testDir, usesServiceSplit ? 'service.test.ts' : 'main.test.ts');
  if (fs.existsSync(testPath)) return;

  const content = usesServiceSplit
    ? `// Tests the real business logic in src/service.ts directly - src/main.ts is a thin, static
// wrapper (see AGENTS.md) not worth testing on its own. Adapt the mocked handlers/assertions
// below once execute() calls something other than what's here now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockSDK, withMockSDK } from '@aivin-labs/sdk';
import { execute } from '../src/service.ts';

test('execute() returns a result', async () => {
  const { client, calls } = createMockSDK({
    handlers: {
      // Add one entry per namespace.method execute() actually calls - see the error message
      // a missing handler throws for the exact string to use, or docs/sdk/*.md in
      // node_modules/@aivin-labs/sdk.
      'ai.prompt': async ({ quest }) => \`Echo: \${quest}\`,
    },
  });

  const result = await withMockSDK(client, () => execute({ text: 'hello' } as any, {} as any));

  assert.ok(result !== undefined);
  // Uncomment once execute() actually calls something:
  // assert.equal(calls[0]?.namespace, 'ai.prompt');
  void calls;
});
`
    : `// Adapt the mocked handlers/assertions below once main() calls something other than what's
// here now (the placeholder calls no SDK method at all, so this passes as-is against a fresh
// \`aivin create\`/\`aivin init\` scaffold).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockSDK, withMockSDK, createMockContext } from '@aivin-labs/sdk';
import { main } from '../src/main.ts';

test('main() returns a success response', async () => {
  const { client, calls } = createMockSDK({
    handlers: {
      // Add one entry per namespace.method main() actually calls - see the error message
      // a missing handler throws for the exact string to use, or docs/sdk/*.md in
      // node_modules/@aivin-labs/sdk.
      'ai.prompt': async ({ quest }) => \`Echo: \${quest}\`,
    },
  });
  const ctx = createMockContext(client);

  const result = await withMockSDK(client, () => main('test mission', { text: 'hello' }, ctx));

  assert.equal(result.status, 'success');
  // Uncomment once main() actually calls something:
  // assert.equal(calls[0]?.namespace, 'ai.prompt');
  void calls;
});
`;

  fs.writeFileSync(testPath, content);
}

async function createGitignore(pluginDir) {
  const gitignorePath = path.join(pluginDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) return;

  const content = ['node_modules/', 'dist/', '.env', '.env.*', '*.log', '.test/', ''].join('\n');
  fs.writeFileSync(gitignorePath, content);
}

// Fields that belong once at the top level of the default { ...commonFields, plugins: [...] }
// manifest shape, shared by every entry - everything else is entry-specific.
const SHARED_MANIFEST_FIELDS = ['version', 'author', 'email', 'license', 'connection_id'];

// CLI-only config keys that may arrive via `aivin create --json` but have no business being
// persisted into manifest.json.
const NON_MANIFEST_CONFIG_KEYS = ['handlerCode', 'overwrite'];

async function createManifest(pluginDir, name, description, aiConfig) {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  let currentManifest = null;
  if (fs.existsSync(manifestPath)) {
    currentManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }

  const overrides = { ...(currentManifest || {}), ...(aiConfig || {}) };
  for (const key of NON_MANIFEST_CONFIG_KEYS) delete overrides[key];

  // Proxy plugins keep the flat single-object shape: they have no src/main.ts export to name in a
  // plugins[] entry's required `func` field.
  if (overrides.proxy_config) {
    const flatManifest = {
      id: randomBytes(16).toString('hex'),
      name,
      description,
      version: '1.0.0',
      author: '',
      email: '',
      initial: {},
      ...overrides,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(flatManifest, null, 2));
    return;
  }

  // An existing plugins[] manifest is already in the default shape - keep it, only filling in
  // missing shared fields.
  if (Array.isArray(overrides.plugins)) {
    const newManifest = { version: '1.0.0', author: '', email: '', ...overrides };
    fs.writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2));
    return;
  }

  const shared = {};
  const entryOverrides = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (SHARED_MANIFEST_FIELDS.includes(key)) shared[key] = value;
    else entryOverrides[key] = value;
  }

  // The default manifest shape: shared fields once at the top level + a plugins[] array, here with
  // a single entry backed by src/main.ts's `main` export. Matches what deploy/runtime already
  // understand for multi-function plugins (see docs/MANIFEST.md) - adding a second function later
  // is just appending another entry. `id` is a local placeholder until the plugin is first
  // deployed, at which point the server assigns (and this CLI writes back) the real one.
  const newManifest = {
    version: '1.0.0',
    author: '',
    email: '',
    ...shared,
    plugins: [
      {
        id: randomBytes(16).toString('hex'),
        name,
        description,
        func: 'main',
        input: {
          data: 'object - Input data for processing',
        },
        output: {
          data: 'object - Processed data result',
        },
        trigger_type: ['manual', 'api', 'chat'],
        initial: {},
        ...entryOverrides,
      },
    ],
  };

  fs.writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2));
}

/**
 * The one entry of a default (single-entry plugins[]) manifest, or the manifest itself for the
 * flat single-object shape - for CLI paths that need to read/patch entry-level fields
 * (`id`, `input`, `description`, ...) without caring which shape is on disk. Mutating the returned
 * object mutates the manifest it came from.
 */
function primaryManifestEntry(manifest) {
  if (manifest && Array.isArray(manifest.plugins) && manifest.plugins.length > 0) {
    return manifest.plugins[0];
  }
  return manifest;
}

async function createHandler(pluginDir, aiConfig) {
  const header =
    '// Import just the namespace(s) you need - see docs/SDK.md for the full list\n' +
    '// (ai, vector, knowledge, task, store, redis, mongo, workspace, agent, realtime, queue, ...).\n' +
    "import { ai } from '@aivin-labs/sdk';\n" +
    "import type { PluginInput, PluginContext, PluginResponse } from '@aivin-labs/sdk';\n" +
    "import { PluginStatus, PluginErrorCode } from '@aivin-labs/sdk';";

  let handlerContent;

  if (aiConfig && aiConfig.handlerCode) {
    handlerContent = `${header}\n\n${aiConfig.handlerCode}\n`;
  } else {
    // One entry point to start with - the scaffolded manifest.json's plugins[0] points at this
    // `main` export via its `func` field. To add more functions, export more named functions here
    // and append one plugins[] entry per function - see docs/MANIFEST.md#multi-function-plugins.
    handlerContent = `${header}

export async function main(mission: string, input: PluginInput, ctx: PluginContext): Promise<PluginResponse> {
  try {
    console.log('Plugin main called:', { mission, input });

    // Example: const summary = await ai.prompt(\`Summarize: \${JSON.stringify(input)}\`);

    return {
      status: PluginStatus.SUCCESS,
      data: {
        processed: input,
        timestamp: new Date().toISOString()
      },
      message: 'Plugin executed successfully!'
    };
  } catch (error: any) {
    console.error('Plugin error:', error);
    return {
      status: PluginStatus.ERROR,
      message: error.message,
      error_code: PluginErrorCode.EXECUTION_FAILED
    };
  }
}
`;
  }

  const srcDir = path.join(pluginDir, 'src');
  if (!fs.existsSync(srcDir)) {
    fs.mkdirSync(srcDir, { recursive: true });
  }
  fs.writeFileSync(path.join(srcDir, 'main.ts'), handlerContent);
}

async function createPackageJson(pluginDir, name, description, currentPackageJson = null) {
  const newPackageJson = {
    name,
    version: '1.0.0',
    description,
    type: 'module',
    scripts: {
      start: 'aivin start',
      // Node's own native TS execution (same mechanism PluginServer.loadPlugin uses to load
      // src/main.ts directly, no separate compile step) - not a new tool/dependency to learn.
      test: 'node --test test/**/*.test.ts',
    },
    dependencies: {
      // Pinned to an exact version, not "latest" - the platform's own AI security scan flags
      // "latest"/range dependency pins as a supply-chain risk (a later, unreviewed version could
      // get pulled in silently) and blocks deployment over it. Reads SDK_VERSION (this CLI's own
      // package.json) rather than a second hardcoded literal, so it can't drift from what's
      // actually published to npm.
      '@aivin-labs/sdk': SDK_VERSION,
    },
    devDependencies: {
      '@types/node': '^24.0.0',
      typescript: '^5.9.3',
    },
    keywords: ['aivin', 'plugin'],
    engines: { node: '>=22.0.0' },
  };

  if (currentPackageJson) {
    const merged = { ...currentPackageJson, ...newPackageJson };
    merged.scripts = { ...newPackageJson.scripts, ...currentPackageJson.scripts };
    merged.dependencies = { ...currentPackageJson.dependencies, ...newPackageJson.dependencies };
    merged.devDependencies = {
      ...newPackageJson.devDependencies,
      ...currentPackageJson.devDependencies,
    };
    merged.keywords = [
      ...new Set([...(currentPackageJson.keywords || []), ...newPackageJson.keywords]),
    ];

    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(merged, null, 2));
  } else {
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify(newPackageJson, null, 2));
  }
}

async function createTsConfig(pluginDir) {
  const tsConfig = {
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022'],
      module: 'ESNext',
      moduleResolution: 'node',
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      strict: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      noImplicitAny: false,
      noImplicitReturns: false,
      noImplicitThis: false,
      noUnusedLocals: false,
      noUnusedParameters: false,
      useUnknownInCatchVariables: false,
    },
    include: ['src/**/*'],
    exclude: ['node_modules', '**/*.test.ts', '**/*.spec.ts'],
  };

  fs.writeFileSync(path.join(pluginDir, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2));
}

async function createEnv(pluginDir) {
  const envContent = [
    '# Local development only. In production the container gets these injected automatically',
    '# by the Aivin host (see DockerHelper.createDockerCompose on the backend) - you do not set',
    '# them yourself when deploying.',
    '',
    'NODE_ENV=development',
    '',
    '# SDK calls default to the production backend (api.aivin.cloud) if this is left unset -',
    '# uncomment to point `npm start` / the local test HTTP shim at a local/dev backend instead.',
    '# SDK_GRPC_ENDPOINT=localhost:50051',
    '# SDK_GRPC_SECRET=',
    '',
  ];

  fs.writeFileSync(path.join(pluginDir, '.env'), envContent.join('\n'));
}

// Command: start plugin server
program
  .command('start')
  .description('Start plugin server')
  .option('--debug', 'Log every sdk.* call live as it happens (human-readable), not just the final trace summary')
  .option('--debug-json', 'Same live per-call logging as --debug, but one JSON object per line on stdout - for a script/coding agent to parse instead of a human')
  .option('--no-watch', 'Disable hot-reload - restart manually (Ctrl+C + `aivin start` again) after editing src/ instead')
  .action((options) => {
    checkNodeVersion();
    const serverPath = path.join(__dirname, 'server.mjs');
    const debugEnv = options.debugJson ? { SDK_DEBUG: 'json' } : options.debug ? { SDK_DEBUG: 'true' } : {};
    const watchEnv = options.watch === false ? { AIVIN_START_WATCH: 'false' } : {};
    const child = spawn('node', [serverPath], {
      stdio: 'inherit',
      env: { ...process.env, ...debugEnv, ...watchEnv },
    });

    child.on('error', (error) => {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        process.exit(code);
      }
    });
  });

// ── Shared deploy helpers ────────────────────────────────────────────────

const DEPLOY_EXCLUDE_DIRS = ['node_modules', '.git', '.tmp', 'dist', 'build', '.test'];
// `package-lock.json` is NOT excluded - the backend's generated Dockerfile runs `npm ci`, which
// requires a lockfile to exist in the build context; see ensureLockfile() below.
const DEPLOY_EXCLUDE_FILES = ['.gitignore', 'yarn.lock'];
// Matches '.env' and every variant (.env.local, .env.production, ...) - these can carry real
// secrets and must never end up in the uploaded `files` payload.
const isEnvFile = (name) => name === '.env' || name.startsWith('.env.');

function readDirectoryRecursive(dir, basePath = '') {
  const files = {};
  const items = fs.readdirSync(dir);

  for (const item of items) {
    const fullPath = path.join(dir, item);
    // Backend keys are always forward-slash, matching how it's later written back with
    // `path.resolve(communityPluginDir, filename)` - on Windows, `path.join` here would produce
    // backslash-separated keys (e.g. "src\\main.ts") that the backend's POSIX filesystem treats as
    // one literal filename containing a backslash, not a nested path - breaking every deploy.
    const relativePath = basePath ? `${basePath}/${item}` : item;
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      if (!DEPLOY_EXCLUDE_DIRS.includes(item)) {
        Object.assign(files, readDirectoryRecursive(fullPath, relativePath));
      }
    } else if (!DEPLOY_EXCLUDE_FILES.includes(item) && !isEnvFile(item)) {
      files[relativePath] = fs.readFileSync(fullPath, 'utf8');
    }
  }

  return files;
}

function incrementVersion(version) {
  const parts = (version || '1.0.0').split('.');
  const patch = parseInt(parts[2] || '0') + 1;
  return `${parts[0] || '1'}.${parts[1] || '0'}.${patch}`;
}

/**
 * Matches the backend's real PluginDeployRequestDto (src/plugins/dto/PluginDTO.ts):
 * { id, manifest, stacks?, files, client?, user_id? }. There's no visibility/scope flag to set here
 * - a plugin deployed through this CLI is always private to your org. The platform's only real
 * "submit to the public store" path is `publish_scope: 'community'` through the browser
 * CodeEditor's `/code/publish` (a different runtime entirely - sandboxed LITE plugins, not this
 * SDK's Docker/gRPC ones); there's currently no CLI-reachable equivalent for that.
 *
 * `files` must be omitted entirely (not sent as `{}`) for a proxy/MCP manifest - the backend's
 * PluginDeploymentService only takes its "manifest-only" branch when `body.files` is falsy
 * (see the `if (body.files) {...} else if (parsedManifest?.proxy_config) {...}` check there); an
 * empty object would still be truthy and misroute a codeless proxy plugin into the code-deploy path.
 *
 * `manifest` here is already flattened (see `flattenManifestFile()`) - a multi-function plugin
 * authored as `{ ...commonFields, plugins: [...] }` on disk arrives here as a flat array of entries.
 * The backend's `deployUnified` checks `Array.isArray(parsedManifest)` BEFORE it even looks at
 * `body.id`, so no top-level `id` is sent for that shape. If every entry declares `proxy_config`
 * there's no code at all (same reasoning as the single-manifest case); otherwise `files` is
 * included, since a multi-function plugin's entries all share one `src/main.ts`/container - see
 * docs/MANIFEST.md#multi-function-plugins.
 */
function buildDeploymentPayload(manifest, pluginFiles) {
  if (Array.isArray(manifest)) {
    const allProxy = manifest.every((m) => m.proxy_config);
    return allProxy ? { manifest } : { manifest, files: pluginFiles };
  }

  const id = manifest.id || manifest.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (manifest.proxy_config) {
    return { id, manifest };
  }
  return { id, manifest, files: pluginFiles };
}

/**
 * The backend's generated Dockerfile runs `npm ci` (not `npm install`) for reproducible builds -
 * that command hard-requires a lockfile to already exist, but `aivin create`'s scaffold doesn't
 * generate one (only `npm install`, a manual step, does). Rather than make deploy depend on the
 * developer remembering to run that first, generate one automatically (fast - `--package-lock-only`
 * skips downloading/writing node_modules) whenever it's missing.
 */
function ensureLockfile(currentDir) {
  const lockPath = path.join(currentDir, 'package-lock.json');
  if (fs.existsSync(lockPath)) return;

  console.log(chalk.gray('   No package-lock.json found - generating one (required for the container build)...'));
  try {
    execSync('npm install --package-lock-only', { cwd: currentDir, stdio: 'pipe' });
  } catch (error) {
    throw new Error(
      `Failed to generate package-lock.json: ${error.stderr?.toString().trim() || error.message}`,
      { cause: error },
    );
  }
}

/**
 * Generates a sample input for `entry.input` (POST /code/generate-sample-data - same AI helper the
 * browser CodeEditor uses) and invokes the freshly deployed plugin with it (POST /plugins/execute),
 * so `aivin test` actually verifies the plugin *runs*, not just that the container built. Returns
 * one result record per entry; never throws - a failure to test is recorded, not fatal to the CLI.
 */
async function smokeTestEntry(serverUrl, authHeaders, entry, workspaceId) {
  const result = { plugin_id: entry.id, name: entry.name, func: entry.func || undefined };

  let sampleInput = {};
  try {
    const sampleRes = await axios.post(
      `${serverUrl}/code/generate-sample-data`,
      { input_schema: entry.input || {}, logic: entry.description },
      authHeaders,
    );
    sampleInput = sampleRes.data || {};
  } catch (error) {
    result.sample_data_error = error.response?.data?.message || error.message;
  }
  result.input = sampleInput;

  const start = Date.now();
  try {
    const execRes = await axios.post(
      `${serverUrl}/plugins/execute`,
      { plugin_id: entry.id, arguments: sampleInput, workspace_id: workspaceId, purpose: 'aivin test - automated smoke test' },
      authHeaders,
    );
    result.duration_ms = Date.now() - start;
    result.response = execRes.data;
    const status = String(execRes.data?.status || '').toLowerCase();
    // A plugin legitimately blocked on human input/auth is not a *failure* of the plugin itself.
    result.passed = ['success', 'waiting', 'needs_auth', 'hil_timeout'].includes(status) || execRes.data?.status === undefined;
  } catch (error) {
    result.duration_ms = Date.now() - start;
    result.passed = false;
    result.error = error.response?.data?.message || error.message;
  }
  return result;
}

/**
 * Runs `smokeTestEntry` for every non-proxy entry and writes a JSON report to `.test/` in the
 * current project - one file per `aivin test` run, so you can diff/compare across runs.
 */
async function runSmokeTest({ currentDir, serverUrl, apiKey, entries, isProxyPlugin, workspaceOverride }) {
  if (isProxyPlugin) {
    console.log(chalk.gray('   Proxy plugin - no generic smoke test to run (calls an external system, not your code).'));
    return;
  }

  const authHeaders = { headers: { Authorization: `Bearer ${apiKey || 'dev-token'}` } };

  let workspaceId = workspaceOverride;
  if (!workspaceId) {
    try {
      const wsRes = await axios.get(`${serverUrl}/workspace/list`, authHeaders);
      const workspaces = Array.isArray(wsRes.data) ? wsRes.data : wsRes.data?.items || [];
      workspaceId = workspaces[0]?.id || workspaces[0]?._id;
    } catch (error) {
      console.log(chalk.yellow(`⚠️  Couldn't look up a workspace to test against (${error.message}) - skipping smoke test. Pass --workspace <id> to specify one directly.`));
      return;
    }
  }
  if (!workspaceId) {
    console.log(chalk.yellow('⚠️  No workspace found for this account - skipping smoke test. Pass --workspace <id> to specify one directly.'));
    return;
  }

  console.log(chalk.blue('🧪 Running smoke test (generated input, real invoke)...'));
  // Give the container a moment to finish binding its gRPC server after the build/up completed.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const results = [];
  for (const entry of entries) {
    // A mixed multi-function batch can have some proxy entries and some real-code entries (see
    // buildDeploymentPayload's doc comment) - the batch-level `isProxyPlugin` check above only
    // catches the all-proxy case, so skip proxy entries individually here too: they call an
    // external system, not your code, same reasoning as the early-return above.
    if (entry.proxy_config) {
      console.log(chalk.gray(`   ${entry.name} - proxy plugin, no generic smoke test to run`));
      continue;
    }
    const result = await smokeTestEntry(serverUrl, authHeaders, entry, workspaceId);
    results.push(result);
    const icon = result.passed ? chalk.green('✅') : chalk.red('❌');
    const label = `${result.name}${result.func ? ` [${result.func}]` : ''}`;
    console.log(`   ${icon} ${label} - ${result.passed ? `passed (${result.duration_ms}ms)` : `failed: ${result.error || 'unexpected status'}`}`);
  }

  // A failure writing the report (permissions, disk full, ...) shouldn't be reported as a failed
  // deploy - the deploy itself already succeeded by the time we get here.
  try {
    const testDir = path.join(currentDir, '.test');
    fs.mkdirSync(testDir, { recursive: true });
    const reportPath = path.join(testDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ timestamp: new Date().toISOString(), workspace_id: workspaceId, passed: results.every((r) => r.passed), results }, null, 2),
    );
    console.log(chalk.gray(`   Report saved: ${path.relative(currentDir, reportPath)}`));
  } catch (error) {
    console.log(chalk.yellow(`⚠️  Smoke test ran, but saving the report failed: ${error.message}`));
  }
}

// Same spinner deployPlugin has always had, factored out so other long-running network calls
// (AI codegen, connector register) get the same "still working, not hung" feedback instead of a
// static line that just sits there for however many seconds the request takes.
async function withSpinner(label, fn) {
  if (!process.stdout.isTTY) {
    console.log(chalk.blue(`${label}...`));
    return fn();
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${chalk.cyan(frames[i])} ${label}...`);
    i = (i + 1) % frames.length;
  }, 100);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
  }
}

// Positional CLI args are declared optional ([arg]) everywhere, not required (<arg>), so Commander
// never hard-fails before the action() runs - every command instead calls this to fill a missing
// value interactively. Falls back to throwing `usage` when there's no TTY to prompt on (scripts/
// CI) or the user leaves the prompt blank, so non-interactive callers still fail fast and loud
// instead of hanging on a prompt nothing will ever answer.
async function requireArg(value, { prompt, usage }) {
  if (value) return value;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const { answer } = await inquirer.prompt([{ type: 'input', name: 'answer', message: prompt }]);
    if (answer) return answer;
  }
  throw new Error(usage);
}

async function deployPlugin({ endpointPath, label, smokeTest, workspaceOverride }) {
  console.log(chalk.blue(`🚀 ${label}...`));

  const currentDir = process.cwd();
  const manifestPath = path.join(currentDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error('manifest.json not found in current directory');
  }

  // `rawManifest` is exactly what's on disk - possibly the ergonomic { ...commonFields, plugins:
  // [...] } multi-function authoring shape (see docs/MANIFEST.md#multi-function-plugins). `manifest`
  // is always either a single object or a flat array, the only two shapes anything downstream of
  // this needs to understand. For the group shape these are DIFFERENT objects (flatten copies
  // fields), so version bump / assigned-id write-back has to target `rawManifest`, not `manifest` -
  // for the other two shapes they're the same object/array, so mutating one mutates both.
  const rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const isGroupShape = !!(rawManifest && typeof rawManifest === 'object' && !Array.isArray(rawManifest) && Array.isArray(rawManifest.plugins));

  const manifest = flattenManifestFile(rawManifest);
  const isBatch = Array.isArray(manifest);
  const entries = isBatch ? manifest : [manifest];

  const isProxyPlugin = entries.every((m) => m.proxy_config);
  if (!isProxyPlugin) {
    ensureLockfile(currentDir);
  }

  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;

  if (isBatch) {
    console.log(
      `📦 ${entries.length} plugins (batch): ${entries.map((m) => `${m.name}${m.func ? `[${m.func}]` : ''}`).join(', ')}`,
    );
  } else {
    console.log(
      `📦 ${manifest.name} v${manifest.version}` +
        (isProxyPlugin ? ` [proxy: ${manifest.proxy_config.type}]` : ''),
    );
  }
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }

  const pluginFiles = isProxyPlugin ? undefined : readDirectoryRecursive(currentDir);
  const deploymentData = buildDeploymentPayload(manifest, pluginFiles);

  const loadingChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let loadingIndex = 0;
  const loadingLabel = isProxyPlugin ? 'Registering proxy manifest...' : 'Uploading and scanning code...';
  const loadingInterval = setInterval(() => {
    process.stdout.write(`\r${chalk.cyan(loadingChars[loadingIndex])} ${loadingLabel}`);
    loadingIndex = (loadingIndex + 1) % loadingChars.length;
  }, 100);

  try {
    const response = await axios.post(`${serverUrl}${endpointPath}`, deploymentData, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey || 'dev-token'}`,
      },
    });

    clearInterval(loadingInterval);
    process.stdout.write('\r' + ' '.repeat(50) + '\r');

    const result = response.data ?? {};
    if (result.success === false) {
      throw new Error(result.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    console.log(chalk.green(`✅ ${label} succeeded!`));
    // deployUnified's array branch returns { group_id, count, plugin_ids } - plugin_ids is in the
    // same order as the entries we sent, so map them back onto each entry's `id`. For the group
    // authoring shape, that means writing into rawManifest.plugins[i] (the flattened `entries` are
    // disposable copies, not what's on disk).
    if (isBatch) {
      if (Array.isArray(result.plugin_ids)) {
        result.plugin_ids.forEach((assignedId, i) => {
          if (!assignedId || !entries[i] || assignedId === entries[i].id) return;
          entries[i].id = assignedId;
          if (isGroupShape && rawManifest.plugins[i]) rawManifest.plugins[i].id = assignedId;
        });
        console.log(chalk.gray(`   Plugin IDs assigned: ${result.plugin_ids.join(', ')}`));
      }
    } else if (result.plugin_id && result.plugin_id !== manifest.id) {
      // The backend's single-plugin deploy path always reassigns the real, persisted id server-side
      // (never equal to what we sent) - `result.plugin_id` is the ONLY place that real id is ever
      // reported back. Without writing it back here, every later `aivin test`/`plugin trigger` call
      // would keep using the id we originally sent, which was never actually saved as this plugin's
      // queryable id, and every /plugins/execute call by id would fail with "plugin not found".
      manifest.id = result.plugin_id;
      console.log(chalk.gray(`   Plugin ID assigned: ${result.plugin_id}`));
    }
    if (result.group_id) {
      console.log(chalk.gray(`   Group ID: ${result.group_id}`));
    }
    if (result.message) {
      console.log(chalk.gray(`   Message: ${result.message}`));
    }

    if (isGroupShape) {
      // One shared `version` field, not one per entry.
      rawManifest.version = incrementVersion(rawManifest.version);
      fs.writeFileSync(manifestPath, JSON.stringify(rawManifest, null, 2));
      console.log(chalk.blue(`🔄 Version auto-incremented to: ${rawManifest.version}`));
    } else {
      entries.forEach((m) => { m.version = incrementVersion(m.version); });
      fs.writeFileSync(manifestPath, JSON.stringify(rawManifest, null, 2));
      console.log(chalk.blue(`🔄 Version auto-incremented to: ${entries.map((m) => m.version).join(', ')}`));
    }

    if (smokeTest) {
      await runSmokeTest({ currentDir, serverUrl, apiKey, entries, isProxyPlugin, workspaceOverride });
    }
  } catch (error) {
    clearInterval(loadingInterval);
    process.stdout.write('\r' + ' '.repeat(50) + '\r');

    const message = error.response?.data?.message || error.message;
    console.log(chalk.red(`❌ ${label} failed:`), message);

    if (error.code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
      console.log(chalk.yellow('🔧 Check if the Aivin server is running and accessible'));
    } else if (error.response?.status === 401 || error.response?.status === 403) {
      console.log(chalk.yellow('🔧 Check your API_KEY environment variable'));
    }

    if (pluginFiles) {
      console.log(
        chalk.gray(`📁 ${Object.keys(pluginFiles).length} files were prepared for deployment`),
      );
    }
    process.exitCode = 1;
  }
}

// Command: deploy plugin to server (always private to your org - see buildDeploymentPayload's
// doc comment above for why there's no public/store-submission scope here)
program
  .command('deploy')
  .description('Deploy plugin to your org on the Aivin server')
  .action(async () => {
    try {
      await deployPlugin({
        endpointPath: '/plugins/deploy',
        label: 'Deploying plugin',
      });
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

// Command: deploy to a throwaway test instance (backend rejects this in production)
program
  .command('test')
  .description(
    'Deploy to a non-production test instance, then smoke-test it with generated input and save a report to .test/',
  )
  .option('--workspace <id>', 'Workspace id to run the smoke test against (default: auto-picks your first one)')
  .option('--no-smoke-test', 'Only deploy - skip the generated-input invoke test and report')
  .action(async (options) => {
    try {
      await deployPlugin({
        endpointPath: '/plugins/test/deploy',
        label: 'Deploying to test instance',
        smokeTest: options.smokeTest !== false,
        workspaceOverride: options.workspace,
      });
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

/**
 * Static (not AI-generated) entry-point wrapper `aivin init` writes to src/main.ts - deterministic
 * every time, so the only AI-generated file is src/service.ts (the actual business logic). Keeps
 * protocol concerns (PluginResponse/PluginStatus/error_code) out of the business logic entirely -
 * `execute()` just returns plain data or throws a plain Error.
 */
function buildInitMainWrapper() {
  return `// This file is a thin, static wrapper - the real business logic lives in src/service.ts
// (regenerate it with \`aivin plugin make "<new description>"\`, targeting src/service.ts).
import { execute } from './service.ts';
import { PluginStatus, PluginErrorCode } from '@aivin-labs/sdk';
import type { PluginInput, PluginContext, PluginResponse } from '@aivin-labs/sdk';

export async function main(mission: string, input: PluginInput, ctx: PluginContext): Promise<PluginResponse> {
  try {
    const data = await execute(input, ctx);
    return { status: PluginStatus.SUCCESS, data, message: 'Success' };
  } catch (error: any) {
    console.error('Plugin error:', error);
    return {
      status: PluginStatus.ERROR,
      message: error.message,
      error_code: PluginErrorCode.EXECUTION_FAILED,
    };
  }
}
`;
}

/**
 * `aivin init`'s code generation - targets src/service.ts (a plain business-logic module, per
 * CodeGenerationHelper's generic "utility file" branch on the backend) instead of src/main.ts (the
 * "MAIN ENTRY POINT, must return PluginResponse" branch `plugin make` targets). Keeps the
 * AI-generated file free of protocol boilerplate - src/main.ts (buildInitMainWrapper, above) is the
 * only place that needs to know about PluginResponse/PluginStatus at all.
 */
async function generateServiceAndWrapper(pluginDir, description, options = {}) {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const servicePath = path.join(pluginDir, 'src', 'service.ts');
  const mainPath = path.join(pluginDir, 'src', 'main.ts');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }

  const logic = `Write the core business logic for an Aivin plugin, as a single exported function:
  export async function execute(input: PluginInput, ctx: PluginContext): Promise<any>
Rules:
- This is PURE business logic - do NOT return a PluginResponse/{status, data, message} envelope, do NOT import or reference PluginStatus/PluginErrorCode. Just return the actual result data, or throw a plain Error on failure - the caller (src/main.ts) handles wrapping it into the plugin's response format.
- "input" fields come from the manifest's "input" description below. Validate required fields are present at the start and throw a clear Error if not.
- Preferred: import only the namespace(s) you need directly, e.g. import { ai, vector, task, store, redis, mongo } from '@aivin-labs/sdk'; then call ai.prompt(...), vector.search(...), etc. Only fall back to import { call } from '@aivin-labs/sdk'; call(namespace, params) if no sugar method fits.
- Import types from '@aivin-labs/sdk' if needed: import type { PluginInput, PluginContext } from '@aivin-labs/sdk';

Business requirement:
${description}`;

  let response;
  try {
    response = await axios.post(
      `${serverUrl}/code/generate`,
      {
        // No `workspace_files` - see makePluginFromDescription's comment on why that would trip
        // the backend's surgical-edit/diff mode.
        logic,
        // code_id = the entry id, the stable identity of this code workspace on the server -
        // it keys the Redis draft, the RAG index over previously generated files, and the live
        // socket room. func = which export of src/main.ts this generation targets.
        code_id: primaryManifestEntry(manifest).id,
        func: primaryManifestEntry(manifest).func || 'main',
        target_file: 'src/service.ts',
        model: options.model,
        provider: options.provider,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey || 'dev-token'}`,
        },
      },
    );
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Code generation failed: ${message}`, { cause: error });
  }

  const result = response.data ?? {};
  if (!result.code) {
    throw new Error('Aivin server did not return generated code.');
  }
  const looksLikeDiffBlob = /^\s*\{\s*"mode"\s*:\s*"(diff|full)"/.test(result.code);
  if (looksLikeDiffBlob) {
    throw new Error(
      'Aivin server returned an internal patch format instead of plain code - this is a server-side bug, not something to write to src/service.ts. Please report it.',
    );
  }

  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  fs.writeFileSync(servicePath, result.code);
  fs.writeFileSync(mainPath, buildInitMainWrapper());

  applyGeneratedManifestFields(manifestPath, manifest, result);
}

/**
 * `aivin init [name]` - the guided, one-command replacement for `aivin create` + `aivin plugin
 * make`: asks just what's needed (name, business description), scaffolds the project, and
 * generates real working code from the description - split into src/service.ts (business logic,
 * AI-generated) + src/main.ts (protocol wrapper, static/deterministic) instead of one file mixing
 * both concerns, per the same architecture as `plugin make` targeting a non-main.ts file.
 */
async function initInteractive(options) {
  console.log(chalk.blue('🚀 Aivin Plugin Init\n'));

  const nameGivenUpfront = !!options.name;
  if (nameGivenUpfront && !/^[a-z0-9-]+$/.test(options.name)) {
    throw new Error('Plugin name must contain only lowercase letters, numbers, and hyphens');
  }
  const pluginDir = nameGivenUpfront ? path.join(process.cwd(), options.name) : process.cwd();
  if (nameGivenUpfront && fs.existsSync(pluginDir)) {
    throw new Error(`Directory already exists: ${pluginDir}`);
  }

  let pluginName = options.name || (nameGivenUpfront ? undefined : path.basename(process.cwd()));

  const nameQuestion = nameGivenUpfront
    ? []
    : [
        {
          type: 'input',
          name: 'name',
          message: 'Plugin name:',
          default: pluginName,
          validate: (input) => {
            if (!input.trim()) return 'Plugin name cannot be empty';
            if (!/^[a-z0-9-]+$/.test(input))
              return 'Plugin name must contain only lowercase letters, numbers, and hyphens';
            return true;
          },
        },
      ];

  const answers = await inquirer.prompt([
    ...nameQuestion,
    {
      type: 'input',
      name: 'description',
      message: 'What should this plugin do? (be specific - this is what generates your code)',
      validate: (input) => (input.trim() ? true : 'A description is required to generate working code'),
    },
  ]);

  pluginName = answers.name || pluginName;
  const description = answers.description;

  console.log(chalk.gray(`\n📁 Scaffolding ${pluginName}...`));
  // input/output start EMPTY (not the generic {data: "..."} placeholder `aivin create` writes) so
  // generateServiceAndWrapper's applyGeneratedManifestFields (which only fills a field that's
  // currently empty) actually applies the schema the AI infers from the description, instead of
  // silently no-op'ing against an already-non-empty placeholder.
  await createPluginProject(pluginDir, pluginName, description, { input: {}, output: {} }, null, {
    skipHandler: true,
  });

  try {
    await withSpinner('🤖 Generating business logic (src/service.ts)', () => generateServiceAndWrapper(pluginDir, description, options));
    console.log(chalk.green('✅ src/service.ts + src/main.ts generated'));
  } catch (error) {
    // Don't leave a half-scaffolded project on generation failure - fall back to the plain
    // placeholder handler (same one `aivin create` writes), so `aivin init` still leaves a working,
    // deployable plugin the developer can fill in by hand or retry with `aivin plugin make`. Also
    // restores the generic input/output placeholder - the empty {} above only makes sense once
    // generation has actually filled it in.
    console.error(chalk.yellow(`⚠️  Code generation failed (${error.message}) - falling back to a placeholder handler.`));
    await createHandler(pluginDir, null);
    const manifestPath = path.join(pluginDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = primaryManifestEntry(manifest);
    if (Object.keys(entry.input || {}).length === 0) entry.input = { data: 'object - Input data for processing' };
    if (Object.keys(entry.output || {}).length === 0) entry.output = { data: 'object - Processed data result' };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  console.log(chalk.green(`\n✅ Plugin initialized!`));
  console.log(`📁 Directory: ${pluginDir}`);
  console.log(chalk.cyan(`\n🔧 Next steps:`));
  if (nameGivenUpfront) {
    console.log(`   cd ${pluginName}  # Enter the new project directory`);
  }
  console.log(`   npm install     # Install dependencies`);
  console.log(`   npm start       # Start plugin locally (gRPC server + HTTP test shim on :4001)`);
}

/** Single call to POST /code/generate - used directly for surgical per-file fixes in
 *  generateProjectWithSelfCorrection. Throws on network/API failure or if the server ever returns
 *  its internal diff-patch blob instead of plain source. */
async function requestCodeGeneration(serverUrl, apiKey, payload) {
  let response;
  try {
    response = await axios.post(`${serverUrl}/code/generate`, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey || 'dev-token'}`,
      },
    });
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Code generation failed: ${message}`, { cause: error });
  }
  const result = response.data ?? {};
  if (!result.code) {
    throw new Error('Aivin server did not return generated code.');
  }
  const looksLikeDiffBlob = /^\s*\{\s*"mode"\s*:\s*"(diff|full)"/.test(result.code);
  if (looksLikeDiffBlob) {
    throw new Error(
      'Aivin server returned an internal patch format instead of plain code - this is a server-side bug, not something to write to src/main.ts. Please report it.',
    );
  }
  return result;
}

// How many times to send tsc's own compiler errors back to the AI and ask it to fix them, on top
// of the first-pass generation. Bounded so a stubborn error (e.g. a package that genuinely isn't
// available in the plugin sandbox) doesn't loop forever burning generation calls.
const CODEGEN_MAX_FIX_ATTEMPTS = 2;

/** Type-checks the freshly generated handler with the scaffolded project's own `typescript`
 *  devDependency - skipped (not failed) when `node_modules` isn't installed yet, e.g. running
 *  `plugin make`/`convert` straight after `aivin create` and before `npm install`. This is what
 *  gives the self-correction loop something concrete to react to: exact `file(line,col)` compiler
 *  errors, not a guess at what might be wrong. */
/**
 * Runs asynchronously (spawn, not execSync) on purpose: this is also called as the `run_typecheck`
 * tool during `plugin convert`, where the process must keep servicing its socket connection (ping/
 * pong, other tool calls) while tsc runs - a synchronous execSync call blocks the whole event loop
 * for as long as tsc takes, which on a real project can be many seconds and risks the server-side
 * ping timeout disconnecting the socket mid-typecheck.
 */
function typeCheckHandler(currentDir) {
  return new Promise((resolve) => {
    const tscBin = path.join(currentDir, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!fs.existsSync(tscBin)) return resolve({ skipped: true, errors: [] });
    const tsconfigPath = path.join(currentDir, 'tsconfig.json');
    // --incremental caches type-check state in a .tsbuildinfo file (outside the project, keyed by
    // a hash of its path - never written into the user's own directory, nothing to .gitignore).
    // On a large `plugin convert` project, the fix loop can call this 2-3 times in one run; without
    // this, every single call is a full cold recompile of every file, not just the 1-2 that changed
    // since the last attempt.
    const buildInfoDir = path.join(os.tmpdir(), 'aivin-tsc-cache');
    const buildInfoPath = path.join(buildInfoDir, `${createHash('md5').update(currentDir).digest('hex')}.tsbuildinfo`);
    fs.mkdirSync(buildInfoDir, { recursive: true });
    const args = fs.existsSync(tsconfigPath)
      ? ['--noEmit', '--incremental', '--tsBuildInfoFile', buildInfoPath, '-p', tsconfigPath]
      : ['--noEmit', '--incremental', '--tsBuildInfoFile', buildInfoPath, '--skipLibCheck', 'src/main.ts'];
    let output = '';
    const child = spawn(process.execPath, [tscBin, ...args], { cwd: currentDir, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => resolve({ skipped: false, errors: [error.message] }));
    child.on('close', (code) => {
      if (code === 0) return resolve({ skipped: false, errors: [] });
      // tsc's real per-error lines all match this ("file(line,col): error TSxxxx: message") - filter
      // out the trailing "Found N errors" summary line so only actionable lines go back to the AI.
      const errorLines = output.split('\n').filter((line) => /error TS\d+/.test(line));
      resolve({ skipped: false, errors: errorLines.length > 0 ? errorLines : [output.trim()].filter(Boolean) });
    });
  });
}

// Off-default ports so this doesn't collide with a real `aivin start` (4001/50051) the developer
// might already have running for the same or another plugin while `plugin convert` is going.
const SMOKE_TEST_HTTP_PORT = 47401;
const SMOKE_TEST_GRPC_BIND = '0.0.0.0:47451';
const SMOKE_TEST_READY_TIMEOUT_MS = 15_000;

/**
 * Runs `aivin plugin convert`'s `run_smoke_test` tool call: spawns the exact same runtime
 * `aivin start` uses (bin/server.mjs, this CLI package's own file - not anything inside the plugin
 * project) against the just-generated project, waits for its local HTTP test shim to come up, POSTs
 * the AI-generated sample input to it, and reports back whether the plugin actually ran
 * successfully - not just whether it type-checks. Always kills the spawned process afterward,
 * success or failure.
 */
async function runSmokeTestHandler(currentDir, args) {
  const sdkPkgPath = path.join(currentDir, 'node_modules', '@aivin-labs', 'sdk');
  if (!fs.existsSync(sdkPkgPath)) return { skipped: true };

  const serverPath = path.join(__dirname, 'server.mjs');
  let stderrOutput = '';
  const child = spawn(process.execPath, [serverPath], {
    cwd: currentDir,
    env: {
      ...process.env,
      LOCAL_TEST_PORT: String(SMOKE_TEST_HTTP_PORT),
      SDK_GRPC_SERVER_BIND: SMOKE_TEST_GRPC_BIND,
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { stderrOutput += chunk.toString().slice(0, 500); });
  child.on('error', () => {}); // reported via the readiness poll failing below, not here

  try {
    const deadline = Date.now() + SMOKE_TEST_READY_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        await axios.get(`http://localhost:${SMOKE_TEST_HTTP_PORT}/health`, { timeout: 1000 });
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    if (!ready) {
      return { skipped: false, success: false, error: `Local runtime didn't become ready within ${SMOKE_TEST_READY_TIMEOUT_MS / 1000}s${stderrOutput ? `: ${stderrOutput}` : ''}` };
    }

    let response;
    try {
      response = await axios.post(
        `http://localhost:${SMOKE_TEST_HTTP_PORT}/invoke`,
        { mission: args.mission || 'smoke-test', input: args.input || {} },
        { timeout: 30_000, validateStatus: () => true },
      );
    } catch (error) {
      return { skipped: false, success: false, error: error.message };
    }

    if (!response.data?.success) {
      return { skipped: false, success: false, error: response.data?.error || `HTTP ${response.status}` };
    }
    const result = response.data.result;
    if (result && typeof result === 'object' && 'status' in result && result.status !== 'success') {
      return { skipped: false, success: false, error: result.message || `Plugin returned status: ${result.status}` };
    }
    return { skipped: false, success: true };
  } finally {
    child.kill('SIGTERM');
  }
}

/**
 * Calls the real AI code generator (POST /code/generate - CodeHandler.generateCode on the
 * frontend, same endpoint the browser CodeEditor uses). That endpoint's default output already
 * targets `main(mission, input, ctx)` + `ctx.sdk.*` + `PluginResponse` - the same conventions this
 * Docker-runtime SDK uses - so the prompt below is reinforcement, not an override.
 */
/** Groups tsc error lines ("file(line,col): error TSxxxx: ...") by the file path they were
 *  reported against - used by generateProjectWithSelfCorrection to know which of a multi-file
 *  project's files to send back for a surgical fix. */
function groupCompilerErrorsByFile(errors, knownPaths) {
  const byFile = new Map();
  for (const line of errors) {
    const match = line.match(/^([^(]+)\(\d+,\d+\)/);
    const filePath = match && knownPaths.has(match[1]) ? match[1] : undefined;
    if (!filePath) continue;
    if (!byFile.has(filePath)) byFile.set(filePath, []);
    byFile.get(filePath).push(line);
  }
  return byFile;
}

/**
 * Writes every file from `/code/generate-project`'s response, then runs a bounded self-correction
 * loop generalized to N files: `typeCheckHandler` already type-checks the whole project (via
 * tsconfig.json) regardless of file count, so this just needs to attribute errors back to the
 * right file (groupCompilerErrorsByFile) and fix each one via a surgical `/code/generate` call
 * (existingContent + target_file triggers the backend's surgical-edit path - the same mechanism
 * `plugin convert`'s action="update" files use).
 */
async function generateProjectWithSelfCorrection(serverUrl, apiKey, currentDir, files, options) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(currentDir, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  const knownPaths = new Set(Object.keys(files));
  for (let attempt = 0; attempt <= CODEGEN_MAX_FIX_ATTEMPTS; attempt++) {
    const check = await withSpinner(attempt === 0 ? '🔎 Type-checking' : `🔧 Re-checking (attempt ${attempt}/${CODEGEN_MAX_FIX_ATTEMPTS})`, () => typeCheckHandler(currentDir));
    if (check.skipped) {
      console.log(chalk.gray('   (skipped type-check - run `npm install` first for the self-correction loop to catch compiler errors)'));
      return files;
    }
    if (check.errors.length === 0) {
      if (attempt > 0) console.log(chalk.green(`✅ Fixed - clean type-check after ${attempt} attempt(s)`));
      return files;
    }

    const byFile = groupCompilerErrorsByFile(check.errors, knownPaths);
    if (attempt === CODEGEN_MAX_FIX_ATTEMPTS || byFile.size === 0) {
      console.log(chalk.yellow(`⚠️  ${check.errors.length} compiler error(s) remain${attempt > 0 ? ` after ${attempt} fix attempt(s)` : ''} - review manually:`));
      check.errors.forEach((line) => console.log(chalk.gray(`   ${line}`)));
      return files;
    }

    console.log(chalk.yellow(`⚠️  ${check.errors.length} compiler error(s) across ${byFile.size} file(s) - asking the AI to fix...`));
    for (const [relPath, errors] of byFile) {
      const fullPath = path.join(currentDir, ...relPath.split('/'));
      const result = await withSpinner(`   fixing ${relPath}`, () =>
        requestCodeGeneration(serverUrl, apiKey, {
          logic: `Fix these compiler errors:\n${errors.join('\n')}`,
          target_file: relPath,
          workspace_files: { [relPath]: files[relPath] },
          model: options.model,
          provider: options.provider,
        }),
      );
      files[relPath] = result.code;
      fs.writeFileSync(fullPath, result.code);
    }
  }
  return files;
}

/**
 * `aivin plugin make` - complexity-adaptive since the backend now classifies the task first
 * (see CodeEditorService.genFreshProject/CodeGenerationHelper.planFreshProject): a simple/moderate
 * requirement still costs exactly one generation call and writes exactly src/main.ts, same as
 * always; a genuinely complex one gets planned into a small multi-file project and a matching
 * multi-entry manifest, instead of everything being crammed into one flat main().
 */
async function makePluginFromDescription(description, options = {}) {
  const currentDir = process.cwd();
  const manifestPath = path.join(currentDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error('manifest.json not found. Run `aivin create` first.');
  }

  // A project created by `aivin init` has src/service.ts (business logic) + a static src/main.ts
  // wrapper - regenerating here should target service.ts too, or it'd overwrite that clean split
  // with a single self-contained main.ts, silently undoing it.
  if (fs.existsSync(path.join(currentDir, 'src', 'service.ts'))) {
    console.log(chalk.gray('src/service.ts found - regenerating business logic there (main.ts wrapper unchanged).'));
    await withSpinner('🤖 Generating business logic (src/service.ts)', () => generateServiceAndWrapper(currentDir, description, options));
    console.log(chalk.green('✅ src/service.ts regenerated'));
    console.log(chalk.cyan('\n🔧 Next steps:'));
    console.log('   aivin start   # test locally');
    console.log('   aivin test    # deploy to a test instance');
    return;
  }

  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entry = primaryManifestEntry(manifest);

  let response;
  try {
    response = await withSpinner('🤖 Generating plugin', () =>
      axios.post(
        `${serverUrl}/code/generate-project`,
        { logic: description, code_id: entry.id, model: options.model, provider: options.provider },
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey || 'dev-token'}` } },
      ),
    );
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Code generation failed: ${message}`, { cause: error });
  }

  const { files, manifest: manifestFragment, plan } = response.data ?? {};
  if (!files || Object.keys(files).length === 0) {
    throw new Error('Aivin server did not return any generated files.');
  }
  if (plan?.multi_entry) {
    console.log(chalk.blue(`🔎 ${plan.reasoning || 'Multiple independent capabilities detected'}`));
  }

  const finalFiles = await generateProjectWithSelfCorrection(serverUrl, apiKey, currentDir, files, options);
  const fileList = Object.keys(finalFiles);
  console.log(chalk.green(`✅ ${fileList.length} file(s) generated`), fileList.length > 1 ? chalk.gray(`(${fileList.join(', ')})`) : '');

  if (manifestFragment?.plugins?.length) {
    // multi_entry: backend planned 2+ independent capabilities - replace plugins[] with them.
    // Fresh ids assigned locally - the server never allocates plugin ids, only `aivin deploy` does.
    manifest.plugins = manifestFragment.plugins.map((p) => ({ id: randomBytes(16).toString('hex'), input: {}, initial: {}, ...p }));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(chalk.green(`✅ manifest.json split into ${manifest.plugins.length} plugin entries`));
  } else if (manifestFragment) {
    applyGeneratedManifestFields(manifestPath, manifest, manifestFragment);
  }

  console.log(chalk.cyan('\n🔧 Next steps:'));
  console.log('   aivin start   # test locally');
  console.log('   aivin test    # deploy to a test instance');
}

/** Shared by `plugin make`/`plugin convert` - fills in whatever manifest fields the AI inferred
 *  alongside the code, but only ones you haven't already set yourself. Entry-level fields are
 *  patched on the primary plugins[] entry for the default manifest shape (see
 *  `primaryManifestEntry`), flat fields for the legacy single-object shape. */
function applyGeneratedManifestFields(manifestPath, manifest, result) {
  const entry = primaryManifestEntry(manifest);
  let manifestChanged = false;
  if (result.description && !entry.description) {
    entry.description = result.description;
    manifestChanged = true;
  }
  const instructions = result.instructions || result.instruction;
  if (instructions && !entry.instructions) {
    entry.instructions = instructions;
    manifestChanged = true;
  }
  const inputSchema = result.input || result.input_schema;
  if (inputSchema && (!entry.input || Object.keys(entry.input).length === 0)) {
    entry.input = inputSchema;
    manifestChanged = true;
  }
  if (manifestChanged) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(chalk.green('✅ manifest.json enriched from generated result'));
  }
}

// Same dirs/files `aivin deploy` already ignores, plus lockfiles and binary-ish assets that are
// never worth reading as source. Only used to keep the TREE clean - actual file CONTENT is never
// read here; the backend requests specific paths back on demand (see runProjectToolServer).
const CONVERT_EXCLUDE_DIRS = [...DEPLOY_EXCLUDE_DIRS, 'coverage', '.next', '.cache', '.vscode', '.idea'];
const CONVERT_EXCLUDE_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.gitignore'];
const CONVERT_BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|zip|tar|gz|pdf|mp4|mp3|wasm|node)$/i;
const CONVERT_MAX_TREE_ENTRIES = 5000; // matches the backend's own cap (assertSafeProjectTree)

/**
 * Builds the directory tree `plugin convert` uploads - paths + byte sizes ONLY, never content.
 * Keeps the initial request cheap regardless of project size (previously this walked the whole
 * project reading every file's content up front - wasteful and doesn't scale to a large/heavy
 * project). The backend's ProjectConversionService scans this tree and asks for specific files
 * back one at a time via `code:tool_call` (see runProjectToolServer below) as its own plan loop
 * decides it actually needs them.
 */
function buildProjectTree(dir, basePath = '', entries = []) {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    if (entries.length >= CONVERT_MAX_TREE_ENTRIES) break;
    const fullPath = path.join(dir, item);
    const relativePath = path.join(basePath, item).split(path.sep).join('/');
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (!CONVERT_EXCLUDE_DIRS.includes(item)) buildProjectTree(fullPath, relativePath, entries);
    } else if (!CONVERT_EXCLUDE_FILES.includes(item) && !isEnvFile(item) && !CONVERT_BINARY_EXT.test(item)) {
      entries.push({ path: relativePath, size: stat.size });
    }
  }
  return entries;
}

/** Resolves a backend-requested relative path against the real project directory, rejecting
 *  anything that would escape it. This is the actual security boundary for the tool-call relay -
 *  the backend validates paths too (assertSafeProjectPath), but this process is the one holding
 *  the real filesystem, so this check is the one that actually matters. */
function resolveProjectPath(currentDir, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath) throw new Error('Invalid path');
  const resolved = path.resolve(currentDir, requestedPath);
  const rootWithSep = currentDir.endsWith(path.sep) ? currentDir : currentDir + path.sep;
  if (resolved !== currentDir && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Path escapes project directory: ${requestedPath}`);
  }
  return resolved;
}

/** Best-effort `git status --porcelain -- <path>` for one file - execFileSync (argv array, no
 *  shell) rather than execSync, since `path` came from the backend's AI-generated plan and could
 *  contain characters that would be unsafe to interpolate into a shell string. Returns null (not
 *  an error) when the directory isn't a git repo, `git` isn't installed, or the file is clean -
 *  this is a confirmation hint, never a hard requirement. */
function describeGitStatus(currentDir, relPath) {
  try {
    const output = execFileSync('git', ['status', '--porcelain', '--', relPath], { cwd: currentDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = output.split('\n').find((l) => l.trim());
    if (!line) return null;
    const code = line.slice(0, 2).trim();
    return code === '??' ? 'untracked' : 'has uncommitted changes';
  } catch {
    return null;
  }
}

/** Warns (and, in an interactive terminal, asks to confirm) before a conversion that may overwrite
 *  existing files starts, if the project has uncommitted changes - conversion can pick actual
 *  existing files as action="update" targets, and there's no undo once create_file writes over
 *  one. Never blocks a non-git directory or non-interactive (CI/script) use - just informs. */
async function warnIfGitDirty(currentDir) {
  let statusOutput;
  try {
    statusOutput = execFileSync('git', ['status', '--porcelain'], { cwd: currentDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return; // not a git repo (or git missing) - nothing to warn about
  }
  const dirtyCount = statusOutput.split('\n').filter((l) => l.trim()).length;
  if (dirtyCount === 0) return;
  console.log(chalk.yellow(`⚠️  ${dirtyCount} uncommitted change(s) in this repo - conversion may update existing files based on what it reads.`));
  if (!process.stdin.isTTY || !process.stdout.isTTY) return; // can't prompt - warning above is all we can do
  const { proceed } = await inquirer.prompt([{ type: 'confirm', name: 'proceed', message: 'Continue anyway?', default: false }]);
  if (!proceed) throw new Error('Cancelled - commit or stash your changes first, then re-run.');
}

/** Executes one `code:tool_call` the backend sent during project conversion, against the real
 *  project directory on disk. See CodeDTO.ts's ProjectTool on the backend for the full contract. */
async function executeProjectTool(currentDir, tool, args) {
  switch (tool) {
    case 'read_file': {
      const filePath = resolveProjectPath(currentDir, args.path);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        throw new Error(`File not found: ${args.path}`);
      }
      return fs.readFileSync(filePath, 'utf8');
    }
    case 'grep': {
      const regex = new RegExp(args.pattern, 'i');
      const matches = [];
      const walk = (dir, base = '') => {
        for (const item of fs.readdirSync(dir)) {
          if (matches.length >= 20) return;
          const fullPath = path.join(dir, item);
          const rel = path.join(base, item).split(path.sep).join('/');
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            if (!CONVERT_EXCLUDE_DIRS.includes(item)) walk(fullPath, rel);
          } else if (!CONVERT_BINARY_EXT.test(item) && stat.size > 0 && stat.size <= 200_000) {
            if (regex.test(fs.readFileSync(fullPath, 'utf8'))) matches.push(rel);
          }
        }
      };
      walk(currentDir);
      return matches;
    }
    case 'confirm_update': {
      const filePath = resolveProjectPath(currentDir, args.path);
      if (!fs.existsSync(filePath)) return { approved: true }; // nothing there to overwrite
      const gitHint = describeGitStatus(currentDir, args.path);
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        // Non-interactive (CI/script) - can't prompt, so proceed but make the decision visible.
        console.log(chalk.yellow(`⚠️  Non-interactive - overwriting existing file ${args.path}${gitHint ? ` (${gitHint})` : ''} without confirmation`));
        return { approved: true };
      }
      const { approved } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'approved',
          message: `Overwrite existing file ${args.path}${gitHint ? ` (${gitHint})` : ''}?`,
          default: false,
        },
      ]);
      return { approved };
    }
    case 'create_file': {
      const filePath = resolveProjectPath(currentDir, args.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, args.content ?? '');
      return { written: true };
    }
    case 'run_typecheck':
      return await typeCheckHandler(currentDir);
    case 'run_smoke_test':
      return await runSmokeTestHandler(currentDir, args);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

/** Wires the socket side of the tool-call relay: joins the conversion's room, executes every
 *  `code:tool_call` the backend sends against the real project directory, replies with
 *  `code:tool_result`, and prints every `code:progress` event live so a loop that can take a
 *  while (scan → plan → generate → verify, possibly several files) doesn't look hung. */
async function connectProjectToolServer(serverUrl, apiKey, codeId, currentDir) {
  const socket = io(serverUrl, { auth: { token: apiKey || 'dev-token' }, transports: ['websocket'], reconnection: true });

  await new Promise((resolve, reject) => {
    socket.on('connect_error', (error) => reject(new Error(`Connection failed: ${error.message}`)));
    socket.on('connect', () => {
      socket.emit('code:join', { code_id: codeId }, (ack) => {
        if (!ack?.success) reject(new Error(`Couldn't join conversion session: ${ack?.error || 'unknown error'}`));
        else resolve();
      });
    });
  });

  socket.on('code:tool_call', async (payload) => {
    const { call_id, tool, args } = payload || {};
    try {
      const result = await executeProjectTool(currentDir, tool, args || {});
      socket.emit('code:tool_result', { call_id, code_id: codeId, ok: true, result });
    } catch (error) {
      socket.emit('code:tool_result', { call_id, code_id: codeId, ok: false, error: error.message });
    }
  });

  socket.on('code:progress', (payload) => {
    console.log(chalk.gray(`[${new Date().toLocaleTimeString()}]`), payload?.message || '');
    if (Array.isArray(payload?.errors)) payload.errors.forEach((e) => console.log(chalk.red('   '), e));
  });

  return socket;
}

/**
 * `aivin plugin convert` - hands the existing project in the current directory to the backend's
 * ProjectConversionService instead of generating locally: uploads only the directory tree (paths
 * + sizes, never content), then answers `read_file`/`grep`/`create_file`/`run_typecheck` tool
 * calls against the real project on disk as the backend's own scan → plan → generate → verify
 * loop asks for them. The backend decides single-vs-multi-function and create-vs-update per file
 * (see PLAN_PROJECT_INSTRUCTION on the backend) - this command no longer guesses that locally.
 */
async function convertExistingProject(hint, options = {}) {
  const currentDir = process.cwd();
  const manifestPath = path.join(currentDir, 'manifest.json');
  const handlerPath = path.join(currentDir, 'src', 'main.ts');

  await warnIfGitDirty(currentDir);

  // --force re-runs the full scan/plan/generate/verify loop even if a previous `plugin convert`
  // already wrote src/main.ts - for when that result turned out wrong, stale, or the project
  // changed since. src/main.ts isn't special-cased out of the tree, so the backend's plan is free
  // to mark it action="update"; the usual confirm_update prompt still gates actually overwriting it.
  if (fs.existsSync(handlerPath) && !options.force) {
    throw new Error(
      'src/main.ts already exists - `plugin convert` is for a project that isn\'t an Aivin plugin yet. ' +
        'Pass --force to re-run conversion anyway (e.g. the previous result was wrong or the project changed).',
    );
  }

  let manifest;
  let codeId;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    codeId = primaryManifestEntry(manifest)?.id || randomBytes(16).toString('hex');
  } else {
    // No `aivin create` needed first - infer a starting manifest from package.json (or the
    // directory name) so there's less setup between "I have a project" and "it's a plugin".
    let pkg = null;
    const pkgPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { /* not JSON we can use */ }
    }
    const name = (pkg?.name || path.basename(currentDir)).replace('@aivin/plugin-', '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    codeId = randomBytes(16).toString('hex');
    // Same default plugins[] shape `aivin create`/`aivin init` scaffold - see createManifest.
    manifest = {
      version: '1.0.0',
      author: '',
      email: '',
      plugins: [{ id: codeId, name, description: pkg?.description || '', func: 'main', input: {}, initial: {} }],
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(chalk.green('✅ manifest.json created'), chalk.gray(`(name: ${name})`));
  }

  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }

  console.log(chalk.blue('📂 Scanning project tree...'));
  const tree = buildProjectTree(currentDir);
  if (tree.length === 0) {
    throw new Error('No source files found in the current directory.');
  }
  console.log(chalk.gray(`   ${tree.length} file(s) in tree (content read on demand by the server, never uploaded up front)`));

  const socket = await connectProjectToolServer(serverUrl, apiKey, codeId, currentDir);

  console.log(chalk.blue('🤖 Converting - this loops (scan → plan → generate → verify), watch for progress below...\n'));
  let response;
  try {
    response = await axios.post(
      `${serverUrl}/code/convert-project`,
      {
        logic: hint || 'Convert the project in the current directory into an Aivin plugin.',
        code_id: codeId,
        hint,
        tree,
        model: options.model,
        provider: options.provider,
      },
      {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey || 'dev-token'}` },
        timeout: 600_000, // a real multi-file scan/plan/generate/verify loop can take several minutes
      },
    );
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Project conversion failed: ${message}`, { cause: error });
  } finally {
    socket.disconnect();
  }

  const { plan, manifest: manifestFragment, verification } = response.data ?? {};

  if (manifestFragment?.plugins?.length) {
    // Backend planned 2+ independent capabilities (multi_entry) - replace plugins[] with them.
    // Fresh ids assigned locally - the server never allocates plugin ids, only `aivin deploy` does.
    manifest.plugins = manifestFragment.plugins.map((p) => ({ id: randomBytes(16).toString('hex'), input: {}, initial: {}, ...p }));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(chalk.green(`✅ manifest.json split into ${manifest.plugins.length} plugin entries`));
  }

  const isJsTsSource = !plan?.source_language || /^(type|java)script$/i.test(plan.source_language);
  const languageNote = isJsTsSource ? '' : `, ported from ${plan.source_language}`;
  console.log(chalk.green(`\n✅ Conversion done`), chalk.gray(`(${plan?.project_kind || 'generic'}${languageNote}, ${plan?.files?.length ?? 0} file(s))`));
  if (!isJsTsSource) {
    console.log(chalk.yellow(`⚠️  Source was ${plan.source_language}, not TypeScript - this is a translated port, not a mechanical conversion. Review generated logic especially carefully, and check for "limitation" comments left where no direct npm equivalent existed.`));
  }
  if (verification && !verification.success) {
    console.log(chalk.yellow(`⚠️  ${verification.ran ? 'Type-check still finds issues after auto-fix attempts' : 'Verification was skipped'} - review before deploying.`));
  }
  console.log(chalk.yellow('\n⚠️  Review the generated code before relying on it - it\'s a strong starting point, not a guarantee.'));
  console.log(chalk.cyan('\n🔧 Next steps:'));
  console.log('   aivin start   # test locally');
  console.log('   aivin test    # deploy to a test instance');
}

/**
 * Resolves which manifest entry `plugin trigger` should invoke: the `--func` match if given, the
 * one-and-only entry for a single-function/single-entry plugin, or a clear error listing the
 * choices for a multi-function plugin with no `--func` given.
 */
function resolveTriggerEntry(manifest, funcOption) {
  const entries = Array.isArray(manifest) ? manifest : [manifest];
  if (funcOption) {
    const entry = entries.find((m) => m.func === funcOption || m.name === funcOption || m.id === funcOption);
    if (!entry) {
      const known = entries.map((m) => `${m.name}${m.func ? ` [${m.func}]` : ''}`).join(', ');
      throw new Error(`No entry matches "${funcOption}". Known: ${known}`);
    }
    return entry;
  }
  if (entries.length === 1) return entries[0];
  const known = entries.map((m) => `${m.name} [${m.func}]`).join(', ');
  throw new Error(`This is a multi-function plugin - pass --func <name> to pick one. Known: ${known}`);
}

/**
 * Subscribes to a deployed plugin's live console output over the same Socket.IO channel
 * `aivin plugin logs` uses (`subscribe-plugin-logs` / `plugin-log`), but returns as soon as
 * subscribing settles (success OR denial) instead of running until Ctrl+C - meant to be opened
 * right before a single `trigger` call and stopped right after, not to own the process lifetime.
 *
 * Subscribing is permission-scoped server-side to plugins you can see the container logs for
 * (your own/org's deployments) - triggering a plugin from the public store that some other org
 * owns will very likely have this come back `subscribed: false`. That's expected, not an error:
 * the caller falls back to the REST result only, same as before `--watch-logs` existed.
 */
async function watchPluginLogLines(pluginId, { serverUrl, apiKey, onLine }) {
  // Explicit connect timeout (not just socket.io-client's own ~20s default) so `trigger
  // --watch-logs` fails fast into "no live output" instead of leaving the whole command feeling
  // stuck for a while first.
  const socket = io(serverUrl, { auth: { token: apiKey || 'dev-token' }, transports: ['websocket'], reconnection: true, timeout: 8000 });
  let subscribed = false;
  let denyReason;

  await new Promise((resolve) => {
    const giveUp = setTimeout(() => {
      denyReason = 'timed out connecting';
      resolve();
    }, 8000);
    socket.on('connect_error', (error) => {
      clearTimeout(giveUp);
      denyReason = error.message;
      resolve();
    });
    socket.on('connect', () => {
      socket.emit('subscribe-plugin-logs', { plugin_id: pluginId }, (ack) => {
        clearTimeout(giveUp);
        if (ack?.success) subscribed = true;
        else denyReason = ack?.error || 'no permission to view this plugin\'s logs';
        resolve();
      });
    });
  });

  if (subscribed) socket.on('plugin-log', onLine);
  return { subscribed, denyReason, stop: () => socket.disconnect() };
}

/**
 * `aivin plugin trigger` - invokes an already-deployed plugin for real via the same
 * `POST /plugins/execute` the platform's own Playground uses (PluginExecutionService.executePlugin
 * on the backend), and prints the result. Two modes:
 * - Direct: `<mission>` + `<input>` (a JSON string) sent as `purpose`/`arguments` as-is.
 * - Auto (`-a/--auto <prompt>`): sends the prompt as `raw_text` instead - the backend's own
 *   `mapDataToSchema` maps it onto `manifest.input` for you (same mechanism the Playground's "Thử
 *   nghiệm" tab uses), same as pasting a free-text request into the platform's chat-style tester.
 *   `<input>` can still be given alongside `-a` for fields you want to force rather than let the AI
 *   infer - explicit `arguments` win over auto-mapped ones per field.
 *
 * By default this only surfaces what `/plugins/execute`'s response itself carries: `processing_log`
 * (the mapping/execution stage messages, all at once, not the plugin's own internal console output)
 * and `mapped_arguments` (only present when `-a` was used). Pass `--watch-logs` to also stream the
 * plugin's own console.log/console.error output inline (subscribes right before the call, same feed
 * `aivin plugin logs` tails) instead of needing a second terminal - see `watchPluginLogLines` for
 * why this silently does nothing for a plugin you don't have log-view permission on.
 *
 * `--id <pluginId>` skips the local manifest.json lookup - required for plugins with no scaffolded
 * project directory, e.g. proxy plugins built by `aivin mcp <url>`, which deploy straight from an
 * in-memory scan and never write a manifest.json anywhere.
 *
 * `--save` writes this run's result to `.test/trigger/<timestamp>.json`; `--compare <file>` diffs
 * the current run against a previously saved one - a lightweight way to turn ad-hoc "thử nghiệm"
 * calls (your own plugin mid-development, or someone else's from the store) into a regression check,
 * without needing the full `aivin test` deploy+smoke-test flow.
 */
async function triggerPlugin(mission, inputJson, options) {
  // Read + validate --compare's file upfront, before spending a real (possibly side-effecting,
  // possibly billable) invocation on a typo'd path.
  let compareAgainst;
  if (options.compare) {
    const comparePath = path.resolve(process.cwd(), options.compare);
    if (!fs.existsSync(comparePath)) {
      throw new Error(`--compare file not found: ${comparePath}`);
    }
    try {
      compareAgainst = JSON.parse(fs.readFileSync(comparePath, 'utf8'));
    } catch (error) {
      throw new Error(`--compare file isn't valid JSON (${comparePath}): ${error.message}`, { cause: error });
    }
  }

  // `--id` bypasses the manifest.json lookup entirely - needed for plugins that were never
  // scaffolded into a local directory (e.g. `aivin mcp <url>` deploys straight from a scan, no
  // src/manifest.json on disk to resolve `entry` from). Without this, testing a freshly-converted
  // MCP plugin from the Playground-equivalent flow was impossible outside the web app.
  let entryId = options.id;
  let entryLabel = options.id;
  if (!entryId) {
    const currentDir = process.cwd();
    const manifestPath = path.join(currentDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('manifest.json not found. Run this from your plugin\'s directory, or pass --id <pluginId>.');
    }
    const manifest = flattenManifestFile(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    const entry = resolveTriggerEntry(manifest, options.func);
    entryId = entry.id;
    entryLabel = `${entry.name}${entry.func ? ` [${entry.func}]` : ''}`;
  }

  const body = { plugin_id: entryId };
  if (options.auto) {
    body.raw_text = options.auto;
    body.purpose = mission || options.auto;
    if (inputJson) {
      try {
        body.arguments = JSON.parse(inputJson);
      } catch (error) {
        throw new Error(`Invalid JSON for <input>: ${error.message}`, { cause: error });
      }
    }
  } else {
    if (!mission || !inputJson) {
      const usage = 'Usage: aivin plugin trigger "<mission>" \'<input JSON>\'  (or: aivin plugin trigger -a "<prompt>")';
      mission = await requireArg(mission, { prompt: 'Mission (why this run was triggered):', usage });
      inputJson = await requireArg(inputJson, { prompt: 'Input (as a JSON string, e.g. {"text":"hello"}):', usage });
    }
    body.purpose = mission;
    try {
      body.arguments = JSON.parse(inputJson);
    } catch (error) {
      throw new Error(`Invalid JSON for <input>: ${error.message}`, { cause: error });
    }
  }
  if (options.agent) body.agent_id = options.agent;

  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }
  const authHeaders = { headers: { Authorization: `Bearer ${apiKey || 'dev-token'}` } };
  // No client-side timeout here before meant a hung backend (or a genuinely stuck plugin - the
  // server side already caps at MAX_DOCKER_TIMEOUT_MS/effectiveTimeout, but that's enforced on the
  // backend, not by this CLI process) could leave `trigger` sitting forever with no feedback short
  // of Ctrl+C. `AIVIN_TRIGGER_TIMEOUT_MS` overrides if 3 minutes isn't enough for a legitimately
  // slow plugin.
  const EXECUTE_TIMEOUT_MS = parseInt(process.env.AIVIN_TRIGGER_TIMEOUT_MS || '180000');
  const WORKSPACE_LOOKUP_TIMEOUT_MS = 15000;

  let workspaceId = options.workspace;
  if (!workspaceId) {
    try {
      const wsRes = await axios.get(`${serverUrl}/workspace/list`, { ...authHeaders, timeout: WORKSPACE_LOOKUP_TIMEOUT_MS });
      const workspaces = Array.isArray(wsRes.data) ? wsRes.data : wsRes.data?.items || [];
      workspaceId = workspaces[0]?.id || workspaces[0]?._id;
    } catch (error) {
      throw new Error(`Couldn't look up a workspace to run against (${error.message}). Pass --workspace <id>.`, { cause: error });
    }
  }
  if (!workspaceId) {
    throw new Error('No workspace found for this account. Pass --workspace <id>.');
  }
  body.workspace_id = workspaceId;

  let logWatcher;
  if (options.watchLogs) {
    logWatcher = await watchPluginLogLines(entryId, {
      serverUrl,
      apiKey,
      onLine: (payload) => {
        const time = new Date(payload.timestamp || Date.now()).toLocaleTimeString();
        const streamColor = payload.stream === 'stderr' ? chalk.red : payload.stream === 'system' ? chalk.yellow : chalk.gray;
        console.log(chalk.gray(`[${time}]`), streamColor(payload.line));
      },
    });
    if (logWatcher.subscribed) {
      console.log(chalk.blue(`📡 Watching live console output for ${entryLabel || entryId}...`));
    } else {
      console.log(chalk.gray(`(--watch-logs: no live console output - ${logWatcher.denyReason})`));
    }
  }

  console.log(chalk.blue(`🚀 Triggering ${entryLabel || entryId}...`));

  let response;
  try {
    response = await axios.post(`${serverUrl}/plugins/execute`, body, { ...authHeaders, timeout: EXECUTE_TIMEOUT_MS });
  } catch (error) {
    if (logWatcher?.subscribed) {
      // Give trailing log lines from this failed call a moment to arrive before disconnecting.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    logWatcher?.stop();
    const message = error.response?.data?.message || error.message;
    throw new Error(`Trigger failed: ${message}`, { cause: error });
  }

  if (logWatcher?.subscribed) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  logWatcher?.stop();

  const result = response.data ?? {};

  if (Array.isArray(result.processing_log) && result.processing_log.length) {
    console.log(chalk.gray('\n--- Log ---'));
    for (const line of result.processing_log) {
      const icon = line.status === 'error' ? chalk.red('✗') : chalk.gray('·');
      console.log(`${icon} ${line.message}`);
    }
  }

  if (result.mapped_arguments) {
    console.log(chalk.gray('\n--- Auto-mapped input ---'));
    console.log(JSON.stringify(result.mapped_arguments, null, 2));
  }

  const status = String(result.status || '').toLowerCase();
  const ok = ['success', 'waiting', 'needs_auth', 'hil_timeout'].includes(status) || result.status === undefined;
  const resultLabel = `--- Result: ${result.status || 'unknown'} ---`;
  console.log(ok ? chalk.green(`\n${resultLabel}`) : chalk.red(`\n${resultLabel}`));
  if (result.message) console.log(chalk.gray(`Message: ${result.message}`));
  if (result.error_code) console.log(chalk.gray(`Error code: ${result.error_code}`));
  console.log(JSON.stringify(result.data ?? null, null, 2));

  if (compareAgainst) {
    printTriggerDiff(compareAgainst.result ?? {}, result);
  }

  if (options.save) {
    const currentDir = process.cwd();
    const dir = path.join(currentDir, '.test', 'trigger');
    fs.mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const savePath = path.join(dir, `${timestamp}.json`);
    fs.writeFileSync(
      savePath,
      JSON.stringify({ plugin_id: entryId, mission: body.purpose, arguments: body.arguments, result }, null, 2),
    );
    console.log(chalk.gray(`\nSaved: ${path.relative(currentDir, savePath)} (--compare ${path.relative(currentDir, savePath)} next time)`));
  }

  if (!ok) process.exitCode = 1;
}

/**
 * Prints a before/after summary for `trigger --compare <file>` - status changes are the headline
 * (a plugin that used to succeed now failing, or vice versa, is the actual regression signal most
 * of the time), full data payloads only get dumped when they actually differ so an unchanged
 * comparison stays a two-line "nothing moved" instead of two walls of identical JSON.
 */
function printTriggerDiff(oldResult, newResult) {
  console.log(chalk.gray('\n--- Compare ---'));

  const oldStatus = oldResult.status ?? 'unknown';
  const newStatus = newResult.status ?? 'unknown';
  if (oldStatus === newStatus) {
    console.log(chalk.gray(`Status: ${newStatus} (unchanged)`));
  } else {
    console.log(chalk.yellow(`Status: ${oldStatus} → ${newStatus} (CHANGED)`));
  }

  const oldData = JSON.stringify(oldResult.data ?? null, null, 2);
  const newData = JSON.stringify(newResult.data ?? null, null, 2);
  if (oldData === newData) {
    console.log(chalk.gray('Data: unchanged'));
  } else {
    console.log(chalk.yellow('Data: CHANGED'));
    console.log(chalk.gray('  --- before ---'));
    console.log(oldData.split('\n').map((l) => `  ${l}`).join('\n'));
    console.log(chalk.gray('  --- after ---'));
    console.log(newData.split('\n').map((l) => `  ${l}`).join('\n'));
  }
}

/**
 * `aivin plugin logs [pluginId]` - tails a deployed plugin's own container stdout/stderr live, over
 * the same Socket.IO channel the platform's own Playground log panel uses (subscribe-plugin-logs /
 * plugin-log, see src/base/SocketIO.ts on the backend). `pluginId` defaults to the current
 * directory's manifest.json id (like `plugin trigger`'s `--func` resolution), so `aivin plugin logs`
 * with no args works from inside a plugin's own project directory.
 */
async function streamPluginLogs(pluginId, options) {
  let resolvedId = pluginId;
  if (!resolvedId) {
    const manifestPath = path.join(process.cwd(), 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('No pluginId given and manifest.json not found. Pass a pluginId or run from your plugin\'s directory.');
    }
    const manifest = flattenManifestFile(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    resolvedId = resolveTriggerEntry(manifest, options.func).id;
  }

  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }

  console.log(chalk.blue(`📡 Watching live logs for ${resolvedId}... (Ctrl+C to stop)\n`));

  const socket = io(serverUrl, {
    auth: { token: apiKey || 'dev-token' },
    transports: ['websocket'],
    reconnection: true,
  });

  const streamColor = (stream) => (stream === 'stderr' ? chalk.red : stream === 'system' ? chalk.yellow : chalk.gray);

  await new Promise((resolve) => {
    let settled = false;
    const stop = () => {
      if (settled) return;
      settled = true;
      socket.disconnect();
      process.off('SIGINT', stop);
      resolve();
    };
    process.on('SIGINT', stop);

    socket.on('connect', () => {
      socket.emit('subscribe-plugin-logs', { plugin_id: resolvedId }, (ack) => {
        if (!ack?.success) {
          console.error(chalk.red('❌'), `Couldn't subscribe: ${ack?.error || 'unknown error'}`);
          stop();
        }
      });
    });
    socket.on('plugin-log', (payload) => {
      const time = new Date(payload.timestamp || Date.now()).toLocaleTimeString();
      console.log(chalk.gray(`[${time}]`), streamColor(payload.stream)(payload.line));
    });
    socket.on('connect_error', (error) => {
      console.error(chalk.red('❌'), `Connection failed: ${error.message}`);
      stop();
    });
  });
}

async function searchPlugins(query, options) {
  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }
  const authHeaders = { headers: { Authorization: `Bearer ${apiKey || 'dev-token'}` } };

  const params = { query };
  if (options.workspace) params.workspace_id = options.workspace;
  if (options.limit) params.limit = options.limit;

  let response;
  try {
    response = await axios.get(`${serverUrl}/plugins/search`, { ...authHeaders, params });
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Search failed: ${message}`, { cause: error });
  }

  // `?limit`/`?page` given -> { items, total, ... } (paged); otherwise a bare array (the same
  // relevance-ranked lookup the platform's own agent uses to auto-select a plugin for a mission).
  const data = response.data;
  const results = Array.isArray(data) ? data : data?.items || [];

  if (results.length === 0) {
    console.log(chalk.yellow(`No plugins found matching "${query}".`));
    return;
  }

  // Interactive browser needs a real terminal to read raw keypresses - fall back to a flat
  // print for scripts/CI or when the user explicitly asks for it with --plain.
  if (process.stdout.isTTY && process.stdin.isTTY && !options.plain) {
    await browseResults(results, `Found ${results.length} plugin(s) matching "${query}":\n`, formatPluginListLine, formatPluginDetail);
    return;
  }

  console.log(chalk.blue(`Found ${results.length} plugin(s) matching "${query}":\n`));
  for (const plugin of results) {
    console.log(chalk.bold(plugin.name || plugin.id) + chalk.gray(`  (${plugin.id})`));
    if (plugin.description) console.log(`  ${plugin.description}`);
    if (plugin.version) console.log(chalk.gray(`  v${plugin.version}`));
    console.log();
  }
  console.log(
    chalk.gray(
      `Call one from your own plugin with: import { call } from '@aivin-labs/sdk'; await call('<plugin_id>', params).`,
    ),
  );
}

function formatPluginListLine(plugin, isSelected) {
  const marker = isSelected ? chalk.cyan('❯ ') : '  ';
  const label = plugin.name || plugin.id;
  const name = isSelected ? chalk.bold.cyan(label) : label;
  const badge = plugin.is_official ? chalk.green(' ✓') : '';
  return `${marker}${name}${badge}${chalk.gray(`  (${plugin.id})`)}`;
}

function trustBadge(plugin) {
  if (plugin.is_official) return chalk.green('✓ official');
  if (plugin.verification_status === 'VERIFIED' || plugin.is_verified) return chalk.cyan('✓ verified');
  return chalk.yellow('community (unverified)');
}

function formatPluginDetail(plugin) {
  const lines = [];
  lines.push(chalk.bold.cyan(plugin.name || plugin.id) + '  ' + trustBadge(plugin));
  lines.push(chalk.gray(plugin.id));
  if (plugin.version) lines.push(`${chalk.gray('version')}      v${plugin.version}`);
  if (plugin.author) lines.push(`${chalk.gray('author')}       ${plugin.author}`);
  if (plugin.type) lines.push(`${chalk.gray('type')}         ${plugin.type}`);
  if (typeof plugin.rating === 'number') lines.push(`${chalk.gray('rating')}       ${plugin.rating.toFixed(1)}/5`);
  if (typeof plugin._similarity === 'number') {
    lines.push(`${chalk.gray('match')}        ${(plugin._similarity * 100).toFixed(0)}%`);
  }
  if (Array.isArray(plugin.capabilities) && plugin.capabilities.length > 0) {
    lines.push(`${chalk.gray('capabilities')} ${plugin.capabilities.join(', ')}`);
  }
  // `initable`: input fields the AI can't fill on its own (API key, token, secret, base_url...)
  // - the user has to configure them once before this plugin can run.
  if (Array.isArray(plugin.initable) && plugin.initable.length > 0) {
    lines.push(chalk.yellow(`⚠ needs setup first: ${plugin.initable.join(', ')}`));
  }
  // `connection_id`: this plugin is bound to a workspace connector (OAuth-based) - the user has
  // to log in to that connector before the plugin can run, separate from `initable`'s plain
  // credential fields.
  if (plugin.connection_id) {
    lines.push(chalk.yellow(`⚠ requires logging in to a connector (${plugin.connection_id}) first`));
  }
  if (plugin.description) lines.push(`\n${plugin.description}`);
  if (plugin.input) lines.push(`\n${chalk.gray('input schema')}\n${JSON.stringify(plugin.input, null, 2)}`);
  if (plugin.output) lines.push(`\n${chalk.gray('output schema')}\n${JSON.stringify(plugin.output, null, 2)}`);
  lines.push(
    chalk.gray(
      `\nCall it with: import { call } from '@aivin-labs/sdk'; await call('${plugin.id}', params).`,
    ),
  );
  return lines.join('\n');
}

// Simple raw-keypress list/detail browser: ↑/↓ to move, space/enter to open an item's detail
// view, esc/backspace to go back to the listing, q/ctrl+c to exit. No extra deps - built on
// node's own readline keypress events since inquirer's prompts don't support this drill-down.
// Generic over what's being browsed (plugins, connectors, ...) via the format callbacks.
function browseResults(results, headerText, formatLine, formatDetail) {
  return new Promise((resolve) => {
    let index = 0;
    let mode = 'list'; // 'list' | 'detail'

    const render = () => {
      // console.clear() no-ops on some Windows TTY hosts (older PowerShell console, plain
      // cmd.exe) - writing the cursor-reset + clear-down sequence directly is what TUI libs
      // like blessed/ink do and works consistently across terminals.
      readline.cursorTo(process.stdout, 0, 0);
      readline.clearScreenDown(process.stdout);
      if (mode === 'list') {
        console.log(chalk.blue(headerText));
        for (let i = 0; i < results.length; i++) {
          console.log(formatLine(results[i], i === index));
        }
        console.log(chalk.gray('\n↑/↓ move   space/enter view details   q quit'));
      } else {
        console.log(formatDetail(results[index]));
        console.log(chalk.gray('\nesc/backspace back   q quit'));
      }
    };

    const onKeypress = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.exit(0);
      }
      if (mode === 'list') {
        if (key.name === 'up') {
          index = (index - 1 + results.length) % results.length;
          render();
        } else if (key.name === 'down') {
          index = (index + 1) % results.length;
          render();
        } else if (key.name === 'return' || key.name === 'space' || str === ' ') {
          mode = 'detail';
          render();
        } else if (key.name === 'q' || key.name === 'escape') {
          cleanup();
          resolve();
        }
      } else {
        if (key.name === 'escape' || key.name === 'backspace') {
          mode = 'list';
          render();
        } else if (key.name === 'q') {
          cleanup();
          resolve();
        }
      }
    };

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('keypress', onKeypress);
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', onKeypress);
    process.stdin.resume();
    render();
  });
}

const pluginCommand = program.command('plugin').description('AI-assisted plugin authoring');

pluginCommand
  .command('search [query]')
  .description("Search the platform's plugin ecosystem for something to reuse instead of writing it yourself")
  .option('--workspace <id>', 'Restrict to plugins visible in this workspace (default: your whole org)')
  .option('--limit <n>', 'Max results to show')
  .option('--plain', 'Print a flat list instead of the interactive browser (for scripts/CI)')
  .action(async (query, options) => {
    try {
      query = await requireArg(query, { prompt: 'What are you looking for?', usage: 'Usage: aivin plugin search "<query>"' });
      await searchPlugins(query, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginCommand
  .command('make [description]')
  .description('Generate src/main.ts from a natural-language business description')
  .option('--model <model>', 'LLM model to use for generation')
  .option('--provider <provider>', 'LLM provider to use for generation')
  .action(async (description, options) => {
    try {
      description = await requireArg(description, { prompt: 'What should this plugin do?', usage: 'Usage: aivin plugin make "<description>"' });
      await makePluginFromDescription(description, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginCommand
  .command('convert [hint]')
  .description('Turn an existing project in the current directory into an Aivin plugin')
  .option('--model <model>', 'LLM model to use for generation')
  .option('--provider <provider>', 'LLM provider to use for generation')
  .option('--force', 'Re-run conversion even if src/main.ts already exists (e.g. redo a previous bad/stale result)')
  .action(async (hint, options) => {
    try {
      await convertExistingProject(hint, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginCommand
  .command('trigger [mission] [input]')
  .description('Invoke this deployed plugin for real and print the result - like the platform\'s Playground')
  .option('-a, --auto <prompt>', 'Natural-language prompt - the platform auto-maps it onto the input schema for you')
  .option('--id <pluginId>', 'Plugin id to trigger directly - skips the local manifest.json lookup (e.g. for `aivin mcp` plugins, which have no local project directory)')
  .option('--func <name>', 'Which function to trigger, for a multi-function plugin (matches name/func/id) - ignored when --id is given')
  .option('--workspace <id>', 'Workspace id to run against (default: auto-picks your first one)')
  .option('--agent <id>', 'Agent id to run as, if the plugin needs one for HIL/confirm behavior to be accurate')
  .option('--watch-logs', 'Also stream the plugin\'s own live console output inline (same feed as `aivin plugin logs`) instead of needing a second terminal - requires permission to view that plugin\'s logs (your own/org\'s deployments; most store plugins from other orgs will just skip this and fall back to the REST result only)')
  .option('--save', 'Write this run\'s result to .test/trigger/<timestamp>.json for later --compare')
  .option('--compare <file>', 'Diff this run\'s result against a previously --save\'d .test/trigger/*.json file')
  .action(async (mission, input, options) => {
    try {
      await triggerPlugin(mission, input, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

pluginCommand
  .command('logs [pluginId]')
  .description('Tail a deployed plugin\'s own console output live (defaults to the current directory\'s manifest.json id)')
  .option('--func <name>', 'Which function\'s id to resolve, for a multi-function plugin (only used when pluginId is omitted)')
  .action(async (pluginId, options) => {
    try {
      await streamPluginLogs(pluginId, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

// ── Connectors - reusable OAuth apps / credential-form namespaces plugins can reference ────────

function connectorAuthHeaders() {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }
  return { headers: { Authorization: `Bearer ${apiKey || 'dev-token'}` } };
}

function connectorBaseUrl() {
  return process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
}

function formatConnectorListLine(connector, isSelected) {
  const marker = isSelected ? chalk.cyan('❯ ') : '  ';
  const label = connector.name || connector.id;
  const name = isSelected ? chalk.bold.cyan(label) : label;
  const badge = connector.is_official ? chalk.green(' ✓') : '';
  const deprecated = connector.deprecated ? chalk.red(' [deprecated]') : '';
  return `${marker}${name}${badge}${deprecated}${chalk.gray(`  (${connector.id}, ${connector.type})`)}`;
}

function formatConnectorDetail(connector) {
  const lines = [];
  lines.push(chalk.bold.cyan(connector.name || connector.id) + '  ' + trustBadge(connector));
  lines.push(chalk.gray(connector.id));
  lines.push(`${chalk.gray('type')}       ${connector.type}`);
  lines.push(`${chalk.gray('visibility')} ${connector.visibility}${connector.store_status ? ` (${connector.store_status})` : ''}`);
  if (connector.description) lines.push(`\n${connector.description}`);
  if (connector.type === 'oauth' && connector.oauth) {
    lines.push(`\n${chalk.gray('authorize_url')} ${connector.oauth.authorize_url}`);
    lines.push(`${chalk.gray('access_url')}    ${connector.oauth.access_url}`);
    if (connector.oauth.scopes?.length) lines.push(`${chalk.gray('scopes')}        ${connector.oauth.scopes.join(', ')}`);
  } else if (connector.type === 'credential_form' && connector.fields?.length) {
    lines.push(`\n${chalk.gray('fields')}\n${connector.fields.map(f => `  - ${f.name}${f.required ? ' (required)' : ''}${f.label ? `: ${f.label}` : ''}`).join('\n')}`);
  }
  lines.push(chalk.gray(`\nReference it from a plugin manifest's connection_id: "${connector.id}"`));
  return lines.join('\n');
}

async function searchConnectors(query, options) {
  const params = { query };
  if (options.limit) params.limit = options.limit;

  let response;
  try {
    response = await axios.get(`${connectorBaseUrl()}/connectors/search`, { ...connectorAuthHeaders(), params });
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Search failed: ${message}`, { cause: error });
  }

  const results = response.data || [];
  if (results.length === 0) {
    console.log(chalk.yellow(`No connectors found matching "${query}".`));
    return;
  }

  if (process.stdout.isTTY && process.stdin.isTTY && !options.plain) {
    await browseResults(results, `Found ${results.length} connector(s) matching "${query}":\n`, formatConnectorListLine, formatConnectorDetail);
    return;
  }

  console.log(chalk.blue(`Found ${results.length} connector(s) matching "${query}":\n`));
  for (const c of results) {
    console.log(chalk.bold(c.name || c.id) + chalk.gray(`  (${c.id}, ${c.type})`));
    if (c.description) console.log(`  ${c.description}`);
    console.log();
  }
}

async function listConnectors(options) {
  const params = {};
  if (options.page) params.page = options.page;
  if (options.limit) params.limit = options.limit;
  if (options.includeDeprecated) params.include_deprecated = 'true';

  let response;
  try {
    response = await axios.get(`${connectorBaseUrl()}/connectors/list`, { ...connectorAuthHeaders(), params });
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`List failed: ${message}`, { cause: error });
  }

  const { items = [], total = 0 } = response.data || {};
  if (items.length === 0) {
    console.log(chalk.yellow('No connectors found.'));
    return;
  }

  if (process.stdout.isTTY && process.stdin.isTTY && !options.plain) {
    await browseResults(items, `${total} connector(s):\n`, formatConnectorListLine, formatConnectorDetail);
    return;
  }

  console.log(chalk.blue(`${total} connector(s):\n`));
  for (const c of items) {
    console.log(chalk.bold(c.name || c.id) + chalk.gray(`  (${c.id}, ${c.type})`));
    if (c.description) console.log(`  ${c.description}`);
    console.log();
  }
}

async function registerConnector() {
  console.log(chalk.blue('🔌 Register a new connector\n'));

  const base = await inquirer.prompt([
    { type: 'input', name: 'id', message: 'Connector id (e.g. mailgun):' },
    { type: 'input', name: 'name', message: 'Display name:' },
    { type: 'input', name: 'description', message: 'Description (optional):' },
    { type: 'input', name: 'image', message: 'Logo/icon URL (optional):' },
    {
      type: 'select',
      name: 'type',
      message: 'Connector type:',
      choices: [
        { name: 'oauth - login flow (client_id/secret, authorize/token URLs)', value: 'oauth' },
        { name: 'credential_form - plain fields the user fills in (host, api_key, ...)', value: 'credential_form' },
      ],
    },
    {
      type: 'select',
      name: 'visibility',
      message: 'Visibility:',
      choices: [
        { name: 'private - only your org can reuse it', value: 'private' },
        { name: 'public - any org can find/reuse it (needs admin review first)', value: 'public' },
      ],
    },
  ]);

  const dto = { id: base.id, name: base.name, description: base.description || undefined, image: base.image || undefined, type: base.type, visibility: base.visibility };

  if (base.type === 'oauth') {
    const oauth = await inquirer.prompt([
      { type: 'input', name: 'authorize_url', message: 'Authorize URL:' },
      { type: 'input', name: 'access_url', message: 'Token/access URL:' },
      { type: 'input', name: 'profile_url', message: 'Profile URL (optional):' },
      { type: 'input', name: 'client_id', message: 'Client id:' },
      { type: 'password', name: 'client_secret', message: 'Client secret:' },
      { type: 'input', name: 'scopes', message: 'Scopes (comma-separated, optional):' },
    ]);
    dto.oauth = {
      authorize_url: oauth.authorize_url,
      access_url: oauth.access_url,
      profile_url: oauth.profile_url || undefined,
      client_id: oauth.client_id,
      client_secret: oauth.client_secret,
      scopes: oauth.scopes ? oauth.scopes.split(',').map((s) => s.trim()).filter(Boolean) : [],
    };
  } else {
    const fields = [];
    console.log(chalk.gray('Add the fields a user must fill in (leave name blank to stop):'));
    for (;;) {
      const f = await inquirer.prompt([
        { type: 'input', name: 'name', message: `Field ${fields.length + 1} name:` },
      ]);
      if (!f.name) break;
      const rest = await inquirer.prompt([
        { type: 'input', name: 'label', message: 'Label (optional):' },
        { type: 'select', name: 'type', message: 'Type:', choices: ['string', 'number', 'boolean', 'secret'], default: 'string' },
        { type: 'confirm', name: 'required', message: 'Required?', default: true },
      ]);
      fields.push({ name: f.name, label: rest.label || undefined, type: rest.type, required: rest.required });
    }
    if (fields.length === 0) throw new Error('credential_form connectors need at least one field');
    dto.fields = fields;
  }

  // Warn about likely-duplicate connectors before submitting - registering "Gmail" when
  // official.google already covers the same thing just fragments the catalog.
  try {
    const dupRes = await withSpinner('🔎 Checking for similar connectors', () =>
      axios.get(`${connectorBaseUrl()}/connectors/check-duplicate`, {
        ...connectorAuthHeaders(),
        params: { name: dto.name },
      }),
    );
    const duplicates = dupRes.data?.duplicates || [];
    if (duplicates.length > 0) {
      console.log(chalk.yellow(`\n⚠ Similar connector(s) already exist - here's what they already provide, in case you can just reuse one instead:\n`));
      for (const d of duplicates) {
        console.log(formatConnectorDetail(d));
        console.log(chalk.gray('─'.repeat(40)));
      }
      const { proceed } = await inquirer.prompt([
        { type: 'confirm', name: 'proceed', message: 'Register this one anyway?', default: false },
      ]);
      if (!proceed) {
        console.log(chalk.gray('Cancelled.'));
        return;
      }
      dto.confirm_duplicate = true;
    }
  } catch (error) {
    console.log(chalk.gray(`(couldn't check for duplicates: ${error.message || 'unknown error'} - continuing)`));
  }

  try {
    const res = await withSpinner('🔌 Registering connector', () =>
      axios.post(`${connectorBaseUrl()}/connectors/register`, dto, connectorAuthHeaders()),
    );
    console.log(chalk.green(`\n✅ Registered connector "${res.data.connector.id}"`));
    console.log(chalk.gray(`   Reference it from a plugin manifest's connection_id: "${res.data.connector.id}"`));
  } catch (error) {
    const message = error.response?.data?.message?.message || error.response?.data?.message || error.message;
    throw new Error(`Register failed: ${message}`, { cause: error });
  }
}

const connectorCommand = program.command('connector').description('Register and discover reusable connectors (OAuth apps / credential-form namespaces)');

connectorCommand
  .command('register')
  .description('Register a new connector namespace, interactively')
  .action(async () => {
    try {
      await registerConnector();
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

connectorCommand
  .command('search [query]')
  .description("Search connectors for something to reuse instead of registering a new one")
  .option('--limit <n>', 'Max results to show')
  .option('--plain', 'Print a flat list instead of the interactive browser (for scripts/CI)')
  .action(async (query, options) => {
    try {
      query = await requireArg(query, { prompt: 'What are you looking for?', usage: 'Usage: aivin connector search "<query>"' });
      await searchConnectors(query, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

connectorCommand
  .command('list')
  .description('List connectors visible to your org')
  .option('--page <n>', 'Page number')
  .option('--limit <n>', 'Items per page')
  .option('--include-deprecated', "Also show your org's deprecated connectors (hidden by default)")
  .option('--plain', 'Print a flat list instead of the interactive browser (for scripts/CI)')
  .action(async (options) => {
    try {
      await listConnectors(options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

connectorCommand
  .command('deprecate [id]')
  .description("Hide a connector you own from search/list without breaking plugins already using it")
  .action(async (id) => {
    try {
      id = await requireArg(id, { prompt: 'Connector id to deprecate:', usage: 'Usage: aivin connector deprecate <id>' });
      await axios.post(`${connectorBaseUrl()}/connectors/${encodeURIComponent(id)}/deprecate`, {}, connectorAuthHeaders());
      console.log(chalk.green(`✅ "${id}" is now deprecated - still usable, hidden from new search/list.`));
    } catch (error) {
      const message = error.response?.data?.message || error.message;
      console.error(chalk.red('❌'), message);
      process.exit(1);
    }
  });

connectorCommand
  .command('undeprecate [id]')
  .description('Make a previously-deprecated connector you own discoverable again')
  .action(async (id) => {
    try {
      id = await requireArg(id, { prompt: 'Connector id to un-deprecate:', usage: 'Usage: aivin connector undeprecate <id>' });
      await axios.post(`${connectorBaseUrl()}/connectors/${encodeURIComponent(id)}/undeprecate`, {}, connectorAuthHeaders());
      console.log(chalk.green(`✅ "${id}" is discoverable again.`));
    } catch (error) {
      const message = error.response?.data?.message || error.message;
      console.error(chalk.red('❌'), message);
      process.exit(1);
    }
  });

// ── MCP proxy plugins - wrap an external MCP server tool/resource/prompt, no code required ────

/**
 * Builds a manifest-only plugin (`proxy_config.type === 'mcp'`) - the host calls straight through
 * to the external MCP server, so unlike `aivin create` this writes no src/main.ts/package.json/
 * tsconfig - there is no code to run. Matches the backend's McpProxyConfig field-for-field
 * (src/plugins/dto/proxy/McpProxyConfig.ts).
 */
function buildMcpManifest(name, description, opts) {
  const proxyConfig = {
    type: 'mcp',
    mcp_transport: opts.transport,
    mcp_command: opts.transport === 'stdio' ? opts.command : undefined,
    mcp_args: opts.transport === 'stdio' && opts.args ? opts.args.split(' ').filter(Boolean) : undefined,
    mcp_url: opts.transport === 'sse' ? opts.url : undefined,
    mcp_kind: opts.kind || 'tool',
    mcp_tool_name: (opts.kind || 'tool') === 'tool' ? opts.toolName : undefined,
    mcp_resource_uri: opts.kind === 'resource' ? opts.resourceUri : undefined,
    mcp_resource_mime_type: opts.kind === 'resource' ? opts.resourceMimeType : undefined,
    mcp_prompt_name: opts.kind === 'prompt' ? opts.promptName : undefined,
    auth_type: opts.authSecretKey ? 'bearer' : undefined,
    auth_secret_key: opts.authSecretKey,
  };

  return {
    id: randomBytes(16).toString('hex'),
    name,
    description,
    version: '1.0.0',
    input: { data: 'object - parameters forwarded to the MCP tool/resource/prompt as-is' },
    output: { data: 'object - the MCP server response content, unwrapped' },
    proxy_config: proxyConfig,
  };
}

async function createMcpProxyPlugin(name, options) {
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error('Plugin name must contain only lowercase letters, numbers, and hyphens');
  }

  let opts = {
    transport: options.transport,
    command: options.command,
    args: options.args,
    url: options.url,
    kind: options.kind,
    toolName: options.toolName,
    resourceUri: options.resourceUri,
    resourceMimeType: options.resourceMimeType,
    promptName: options.promptName,
    authSecretKey: options.authSecretKey,
  };
  let description = options.description;

  // `--transport`/`--kind` are inferable from whichever flags you actually pass - no need to
  // spell out what's already implied. `--command` only makes sense for stdio, `--url` only for
  // sse; `--tool-name`/`--resource-uri`/`--prompt-name` each only make sense for one `--kind`.
  if (!opts.transport) {
    if (opts.command) opts.transport = 'stdio';
    else if (opts.url) opts.transport = 'sse';
  }
  if (!opts.kind) {
    if (opts.resourceUri) opts.kind = 'resource';
    else if (opts.promptName) opts.kind = 'prompt';
    else if (opts.toolName) opts.kind = 'tool';
  }
  // Same default the interactive prompt below offers - applied unconditionally so a fully-flagged
  // non-interactive call (transport inferred, no --description given) doesn't skip straight past
  // needing one and fail validation later with no explanation of what default it could have had.
  if (!description) description = `Proxy for the "${name}" MCP tool`;

  // Non-interactive (scripted/AI) mode once transport is known (explicit or inferred); otherwise prompt.
  if (!opts.transport) {
    console.log(chalk.blue('🔌 New MCP proxy plugin\n'));

    const base = await inquirer.prompt([
      {
        type: 'input',
        name: 'description',
        message: 'Plugin description:',
        default: description || `Proxy for the "${name}" MCP tool`,
      },
      {
        type: 'select',
        name: 'transport',
        message: 'MCP transport:',
        choices: [
          { name: 'stdio (launch a local command)', value: 'stdio' },
          { name: 'sse (remote Streamable HTTP server)', value: 'sse' },
        ],
      },
    ]);
    description = base.description;
    opts.transport = base.transport;

    if (opts.transport === 'stdio') {
      const stdioAnswers = await inquirer.prompt([
        { type: 'input', name: 'command', message: 'Command to launch the MCP server:' },
        { type: 'input', name: 'args', message: 'Arguments (space-separated, optional):' },
      ]);
      opts.command = stdioAnswers.command;
      opts.args = stdioAnswers.args;
    } else {
      const sseAnswers = await inquirer.prompt([
        { type: 'input', name: 'url', message: 'Remote MCP server URL:' },
      ]);
      opts.url = sseAnswers.url;
    }

    const kindAnswers = await inquirer.prompt([
      {
        type: 'select',
        name: 'kind',
        message: 'What does this plugin expose?',
        choices: [
          { name: 'tool (tools/call)', value: 'tool' },
          { name: 'resource (resources/read)', value: 'resource' },
          { name: 'prompt (prompts/get)', value: 'prompt' },
        ],
        default: 'tool',
      },
    ]);
    opts.kind = kindAnswers.kind;

    if (opts.kind === 'tool') {
      opts.toolName = (
        await inquirer.prompt([{ type: 'input', name: 'v', message: 'MCP tool name:' }])
      ).v;
    } else if (opts.kind === 'resource') {
      const resAnswers = await inquirer.prompt([
        { type: 'input', name: 'resourceUri', message: 'Resource URI:' },
        { type: 'input', name: 'resourceMimeType', message: 'Resource MIME type (optional):' },
      ]);
      opts.resourceUri = resAnswers.resourceUri;
      opts.resourceMimeType = resAnswers.resourceMimeType;
    } else {
      opts.promptName = (
        await inquirer.prompt([{ type: 'input', name: 'v', message: 'MCP prompt name:' }])
      ).v;
    }

    const authAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'authSecretKey',
        message:
          'Workspace secret key for auth, if the MCP server needs a Bearer token (optional, leave blank for none):',
      },
    ]);
    opts.authSecretKey = authAnswers.authSecretKey || undefined;
  }

  const manifest = buildMcpManifest(name, description, opts);
  const validation = validatePluginConfig(manifest);
  if (!validation.valid) {
    throw new Error(`Invalid MCP proxy config: ${validation.errors.join(', ')}`);
  }

  const pluginDir = path.join(process.cwd(), name);
  if (fs.existsSync(pluginDir)) {
    throw new Error(`Directory already exists: ${pluginDir}`);
  }
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(chalk.green(`✅ Created ${path.join(name, 'manifest.json')}`));
  console.log(
    chalk.gray('   No src/main.ts/package.json needed - the host calls the MCP server directly.'),
  );
  console.log(chalk.cyan('\n🔧 Next steps:'));
  console.log(`   cd ${name}`);
  console.log('   aivin login   # once, if you haven\'t already');
  console.log('   aivin test    # deploy to a test instance and verify the connection');
  console.log('   aivin deploy  # ship it');
}

/**
 * `aivin mcp <url>` - the one-shot path from "here's an MCP server" to deployed plugin(s):
 * scan (GET the repo/README or handshake a live server) -> let the developer pick which
 * tools/resources/prompts to bring in -> build manifest(s) -> optional interactive edit ->
 * deploy to the caller's own org. Reuses the exact same backend endpoints the FE's MCP-import
 * screen calls (POST /plugins/scan-mcp, /plugins/build-mcp-manifests, /plugins/deploy) - unlike
 * `mcp create`, nothing here is typed by hand (transport/command/tool name all come from the
 * scan), so this is the fast path for "wrap this whole MCP server", not "wrap 1 tool I already
 * know the details of".
 *
 * --publish additionally calls POST /plugins/store/submit per deployed plugin, which re-verifies
 * each one LIVE against the real MCP server (see PluginStoreService.submitPluginForReview on the
 * backend) before it lands in the admin review queue - deploy always happens org-scoped first
 * regardless of --publish, so a rejected/pending submission never blocks your own org from using
 * the plugin.
 */
async function scanAndPublishMcp(url, options) {
  console.log(chalk.blue('🔌 Converting MCP server into plugin(s)\n'));
  console.log(chalk.gray(`   ${url}\n`));

  let scanned;
  try {
    const res = await withSpinner('🔎 Scanning MCP server', () =>
      axios.post(`${connectorBaseUrl()}/plugins/scan-mcp`, { url }, connectorAuthHeaders()),
    );
    scanned = res.data;
  } catch (error) {
    const message = error.response?.data?.message?.message || error.response?.data?.message || error.message;
    throw new Error(`Scan failed: ${message}`, { cause: error });
  }

  const tools = scanned.tools || [];
  const resources = scanned.resources || [];
  const prompts = scanned.prompts || [];
  if (tools.length + resources.length + prompts.length === 0) {
    throw new Error('No tools/resources/prompts discovered at that URL - nothing to convert.');
  }
  console.log(chalk.green(`✅ Found ${tools.length} tool(s), ${resources.length} resource(s), ${prompts.length} prompt(s)`));

  const choices = [
    ...tools.map((t) => ({ name: `${t.name} ${chalk.gray('(tool)')} - ${t.description || 'no description'}`, value: { kind: 'tools', item: t }, checked: true })),
    ...resources.map((r) => ({ name: `${r.name || r.uri} ${chalk.gray('(resource)')} - ${r.description || 'no description'}`, value: { kind: 'resources', item: r }, checked: true })),
    ...prompts.map((p) => ({ name: `${p.name} ${chalk.gray('(prompt)')} - ${p.description || 'no description'}`, value: { kind: 'prompts', item: p }, checked: true })),
  ];
  const { selected } = await inquirer.prompt([
    { type: 'checkbox', name: 'selected', message: 'Which ones become plugins? (space to toggle, enter to continue)', choices, pageSize: 15 },
  ]);
  if (selected.length === 0) {
    console.log(chalk.yellow('Nothing selected - cancelled.'));
    return;
  }

  const filteredScanned = {
    ...scanned,
    tools: selected.filter((s) => s.kind === 'tools').map((s) => s.item),
    resources: selected.filter((s) => s.kind === 'resources').map((s) => s.item),
    prompts: selected.filter((s) => s.kind === 'prompts').map((s) => s.item),
  };

  let manifests;
  try {
    const res = await withSpinner('🛠  Generating plugin manifest(s)', () =>
      axios.post(`${connectorBaseUrl()}/plugins/build-mcp-manifests`, { scanned: filteredScanned }, connectorAuthHeaders()),
    );
    manifests = res.data;
  } catch (error) {
    const message = error.response?.data?.message?.message || error.response?.data?.message || error.message;
    throw new Error(`Building manifest(s) failed: ${message}`, { cause: error });
  }

  console.log(chalk.cyan(`\n📦 ${manifests.length} plugin manifest(s) generated:`));
  manifests.forEach((m, i) => console.log(`   ${i + 1}. ${chalk.bold(m.name)} ${chalk.gray(`(${m.id})`)} - ${m.description || 'no description'}`));

  const { shouldEdit } = await inquirer.prompt([
    { type: 'confirm', name: 'shouldEdit', message: '\nEdit any name/description before deploying?', default: false },
  ]);
  if (shouldEdit) {
    for (const manifest of manifests) {
      const { editThis } = await inquirer.prompt([
        { type: 'confirm', name: 'editThis', message: `Edit "${manifest.name}"?`, default: false },
      ]);
      if (!editThis) continue;
      const edited = await inquirer.prompt([
        { type: 'input', name: 'name', message: 'Name:', default: manifest.name },
        { type: 'input', name: 'description', message: 'Description:', default: manifest.description || '' },
      ]);
      manifest.name = edited.name;
      manifest.description = edited.description;
    }
  }

  // Always deploys org-scoped first, regardless of --publish/--private/--org - there is currently
  // no backend concept of a workspace-level sub-scope narrower than "your org" (--org is an alias
  // of --private, not a distinct tier - see PluginModel: plugins are scoped by `client`/org only).
  console.log(chalk.blue(`\n🚀 Deploying ${manifests.length} plugin(s) to your org...`));
  let deployResult;
  try {
    deployResult = await withSpinner('   Registering proxy manifest(s)', () =>
      axios.post(`${connectorBaseUrl()}/plugins/deploy`, { manifest: manifests }, connectorAuthHeaders()),
    );
  } catch (error) {
    const message = error.response?.data?.message?.message || error.response?.data?.message || error.message;
    throw new Error(`Deploy failed: ${message}`, { cause: error });
  }
  console.log(chalk.green(`✅ Deployed: ${manifests.map((m) => m.name).join(', ')}`));
  if (deployResult.data?.group_id) {
    console.log(chalk.gray(`   group_id: ${deployResult.data.group_id}`));
  }

  if (options.publish) {
    console.log(chalk.blue(`\n📮 Submitting ${manifests.length} plugin(s) for community review...`));
    for (const manifest of manifests) {
      try {
        await withSpinner(`   Submitting "${manifest.name}"`, () =>
          axios.post(`${connectorBaseUrl()}/plugins/store/submit`, { pluginId: manifest.id }, connectorAuthHeaders()),
        );
        console.log(chalk.green(`   ✅ "${manifest.name}" submitted - pending admin review.`));
      } catch (error) {
        const message = error.response?.data?.message?.message || error.response?.data?.message || error.message;
        console.log(chalk.red(`   ❌ "${manifest.name}" submit failed: ${message}`));
      }
    }
  } else {
    console.log(chalk.gray('\n   Visibility: private (your org only). Re-run with --publish to also submit to the community store.'));
  }

  // `aivin plugin trigger`/`logs` normally read the project's own manifest.json - these plugins
  // deploy straight from the scan, never scaffolded into a directory, so print the `--id` form
  // (see triggerPlugin's --id option) instead of leaving the developer to dig the plugin id back
  // out of the manifest(s) printed above.
  console.log(chalk.cyan('\n🧪 Test it (Playground-equivalent):'));
  for (const manifest of manifests) {
    console.log(`   aivin plugin trigger --id ${manifest.id} -a "<try it in natural language>"`);
  }
  console.log(chalk.gray('   (or `aivin plugin logs <pluginId>` in another terminal to watch its live console output)'));

  if (process.stdout.isTTY && process.stdin.isTTY) {
    const { testNow } = await inquirer.prompt([
      { type: 'confirm', name: 'testNow', message: '\nTest one of them right now?', default: manifests.length === 1 },
    ]);
    if (testNow) {
      let target = manifests[0];
      if (manifests.length > 1) {
        const { picked } = await inquirer.prompt([
          { type: 'select', name: 'picked', message: 'Which one?', choices: manifests.map((m) => ({ name: m.name, value: m })) },
        ]);
        target = picked;
      }
      const { prompt } = await inquirer.prompt([
        { type: 'input', name: 'prompt', message: `Prompt to send to "${target.name}":` },
      ]);
      if (prompt) {
        try {
          await triggerPlugin(undefined, undefined, { id: target.id, auto: prompt });
        } catch (error) {
          console.error(chalk.red('❌'), error.message);
        }
      }
    }
  }
}

const mcpCommand = program
  .command('mcp')
  .description('MCP proxy plugins - wrap an external MCP server tool/resource/prompt, no code required');

mcpCommand
  .argument('[url]', 'GitHub/GitLab/npm/Smithery URL, or a live MCP server URL, to scan and convert')
  .option('--publish', 'Deploy to your org, then submit for community store review (needs admin approval)')
  .option('--private', 'Deploy to your org only - default')
  .option('--org', 'Alias of --private - there is no narrower per-workspace scope today')
  .action(async (url, options) => {
    try {
      url = await requireArg(url, {
        prompt: 'GitHub/GitLab/npm/Smithery URL, or a live MCP server URL:',
        usage: 'Usage: aivin mcp <url> [--publish|--private|--org]',
      });
      await scanAndPublishMcp(url, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

mcpCommand
  .command('create [name]')
  .description('Scaffold a manifest-only plugin that proxies to an external MCP server')
  .option('--transport <transport>', 'stdio | sse')
  .option('--command <command>', 'Command to launch the MCP server (stdio transport)')
  .option('--args <args>', 'Space-separated args for --command (stdio transport)')
  .option('--url <url>', 'Remote MCP server URL (sse transport)')
  .option('--kind <kind>', 'tool | resource | prompt (default: tool)')
  .option('--tool-name <name>', 'MCP tool name (kind=tool)')
  .option('--resource-uri <uri>', 'MCP resource URI (kind=resource)')
  .option('--resource-mime-type <mime>', 'MIME type of the resource (kind=resource)')
  .option('--prompt-name <name>', 'MCP prompt name (kind=prompt)')
  .option('--description <description>', 'Plugin description')
  .option(
    '--auth-secret-key <key>',
    'Name of the workspace secret to use as the Bearer token, if the MCP server needs auth',
  )
  .action(async (name, options) => {
    try {
      name = await requireArg(name, { prompt: 'Plugin name (lowercase letters, numbers, hyphens):', usage: 'Usage: aivin mcp create <name>' });
      await createMcpProxyPlugin(name, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

// ── Login - get an API key saved once, machine-wide ─────────────────────────

/**
 * Writes to `~/.aivin/credentials`, not the current project's `.env` - a login is a per-machine
 * context, not a per-project one, so `aivin login` only needs to happen once regardless of how many
 * plugin projects you work in on this machine, and switching targets is just logging in again with
 * a different `baseUrl`. A project's own `.env` can still set `AIVIN_BASE_URL`/`API_KEY` directly to
 * pin itself to something other than the machine's current context - see the dotenv.config()
 * precedence at the top of this file.
 */
function saveGlobalApiKey(apiKey, baseUrl = process.env.AIVIN_BASE_URL || DEFAULT_AIVIN_BASE_URL) {
  return saveActiveContext(baseUrl, apiKey);
}

function openBrowser(url) {
  const platform = process.platform;
  const command =
    platform === 'win32' ? `start "" "${url}"` : platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(command, (error) => {
    if (error) {
      console.log(chalk.yellow('Could not open a browser automatically - open this URL manually:'));
      console.log(chalk.cyan(`   ${url}`));
    }
  });
}

/**
 * Default `aivin login` flow: opens the platform's actual web app (not the API) so the user logs
 * in exactly the way they normally would - custom-domain org, password, Google, OTP, whatever
 * applies to their account - none of that multi-tenant login logic is reimplemented here. A tiny
 * local HTTP server waits for the browser to hand back a freshly-minted API key. The web app side
 * of this handoff lives in ApiKeysTab.jsx (mint + redirect) and ProfileHook.jsx (auto-open the tab) -
 * see docs/CLI.md#aivin-login.
 */
async function browserLogin() {
  // Defaults to the production web app - override with AIVIN_WEB_URL only if you're pointing at a
  // local/dev/staging frontend instead.
  const webBaseUrl = process.env.AIVIN_WEB_URL || 'https://brain.aivin.cloud';

  const state = randomBytes(16).toString('hex');
  let resolveKey, rejectKey;
  const keyPromise = new Promise((resolve, reject) => {
    resolveKey = resolve;
    rejectKey = reject;
  });

  let timeout;
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }

    const key = url.searchParams.get('key');
    const receivedState = url.searchParams.get('state');
    const ok = !!key && receivedState === state;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<html><body style="font-family:sans-serif;text-align:center;padding-top:4rem">' +
        (ok
          ? '<h2>Login successful</h2><p>You can close this window and return to your terminal.</p>'
          : '<h2>Login failed</h2><p>Close this window and retry <code>aivin login</code>.</p>') +
        // Only works on tabs opened via script (window.open), not a typed/clicked URL - harmless
        // no-op otherwise, hence the fallback "you can close this" text above regardless.
        '<script>window.close();</script>' +
        '</body></html>',
    );

    clearTimeout(timeout);
    server.close();
    if (ok) resolveKey(key);
    else rejectKey(new Error('Login callback was missing a key or had a state mismatch'));
  });
  server.on('error', (err) => rejectKey(err));

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  const authUrl = new URL('/', webBaseUrl);
  authUrl.searchParams.set('cli_redirect', `http://127.0.0.1:${port}/callback`);
  authUrl.searchParams.set('cli_state', state);
  authUrl.searchParams.set('cli_name', os.hostname());

  console.log(chalk.blue('🌐 Opening your browser to log in...'));
  console.log(chalk.gray(`   ${authUrl.toString()}`));
  console.log(chalk.gray('   Not opened automatically? Paste that URL into your browser.'));
  console.log(chalk.gray('   Waiting for you to confirm in the browser (5 min timeout)...'));
  openBrowser(authUrl.toString());

  timeout = setTimeout(() => {
    server.close();
    rejectKey(new Error('Timed out waiting for browser login (5 minutes)'));
  }, 5 * 60 * 1000);

  return keyPromise;
}

/**
 * Prompts for email/password directly in the terminal (no browser) and exchanges them for a real
 * session JWT via `POST /user/login`. Only supports the platform's default/shared client
 * (`--client`, falls back to the same 'aivin.cloud' default the web app itself falls back to when
 * no custom-domain org is resolved) - accounts under a custom-domain organization need that domain
 * resolved first, which is exactly what the web login page normally does.
 *
 * This JWT is deliberately never persisted anywhere (unlike the final API key `aivin login` saves
 * to `~/.aivin/credentials`) - every command that needs one (`aivin login --basic`, `aivin key
 * gen`/`revoke`) re-prompts and re-exchanges it fresh. That mirrors the backend on purpose: the
 * `/apikey` routes (list/create/delete) require this session JWT and deliberately do NOT accept an
 * existing API key in its place (see AuthGuard.tryApiKeyAuth's doc comment) - a leaked/scoped key
 * must never be able to mint or revoke other keys on its own.
 */
async function obtainAccessToken(options) {
  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const client = options.client || 'aivin.cloud';

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'email',
      message: 'Email:',
      validate: (input) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) || 'Please enter a valid email address',
    },
    {
      type: 'password',
      name: 'password',
      message: 'Password:',
      mask: '*',
      validate: (input) => input.length > 0 || 'Password is required',
    },
  ]);

  console.log(chalk.yellow('🔄 Logging in...'));
  console.log(
    chalk.gray(
      `   Using client "${client}" - if your account belongs to a custom-domain organization, use ` +
        '`aivin login` (browser flow) instead, which resolves that automatically.',
    ),
  );

  try {
    const loginRes = await axios.post(`${serverUrl}/user/login`, {
      client,
      email: answers.email,
      nickname: answers.email.toLowerCase(),
      password: answers.password,
      auth_type: 'basic',
      auth_provider: 'tenant',
    });
    const accessToken = loginRes.data?.access_token;
    if (!accessToken) throw new Error('Login response did not include an access token');
    return { serverUrl, accessToken };
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Login failed: ${message}`, { cause: error });
  }
}

/**
 * `aivin login --basic`: the login-specific half of the flow above - exchange credentials for a
 * JWT, then mint (replacing any previous same-named key) the one API key that gets saved to
 * `~/.aivin/credentials`.
 */
async function basicLogin(options) {
  const { serverUrl, accessToken } = await obtainAccessToken(options);
  const authHeaders = { headers: { Authorization: `Bearer ${accessToken}` } };
  const deviceName = os.hostname();

  // Replace (not accumulate) a previous key from this same device - `aivin login` re-run on the
  // same machine used to create yet another "Aivin CLI - <host>" entry every time, cluttering the
  // key list with duplicates. Best-effort: if listing/revoking fails for any reason, still proceed
  // to mint a new key rather than blocking login on it.
  try {
    const listRes = await axios.get(`${serverUrl}/apikey`, authHeaders);
    const existing = (listRes.data?.items || []).find((k) => k.name === deviceName);
    if (existing) {
      await axios.delete(`${serverUrl}/apikey/${existing.id || existing._id}`, authHeaders);
    }
  } catch (error) {
    console.log(chalk.gray(`   (couldn't check for an existing key to replace: ${error.message})`));
  }

  try {
    const keyRes = await axios.post(`${serverUrl}/apikey`, { name: deviceName }, authHeaders);
    if (!keyRes.data?.plainKey) throw new Error('Response did not include an API key');
    return keyRes.data.plainKey;
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Failed to create API key: ${message}`, { cause: error });
  }
}

program
  .command('login')
  .argument('[baseUrl]', 'Server to log into (REST API base) - defaults to production (api.aivin.cloud). Pass a staging/self-hosted host to switch the machine\'s active context to it, e.g. `aivin login beta-api.aivin.vn`.')
  .description('Log in and save an API key for plugin deployment (opens your browser by default)')
  .option('-k, --api-key <key>', 'Set API key directly (skip login entirely)')
  .option('--basic', 'Log in with email/password directly in the terminal instead of a browser')
  .option('--google', 'Alias of the default browser flow - pick Google once the page opens')
  .option('--client <client>', 'Client/org id to use with --basic (default: "aivin.cloud")')
  .action(async (baseUrl, options) => {
    try {
      // Bare hostname (no scheme) is the common case for a quick `aivin login beta-api.aivin.vn` -
      // assume https, same as every other *.aivin.* endpoint in this file.
      const resolvedBaseUrl = baseUrl ? (/^https?:\/\//.test(baseUrl) ? baseUrl : `https://${baseUrl}`) : DEFAULT_AIVIN_BASE_URL;
      process.env.AIVIN_BASE_URL = resolvedBaseUrl;

      if (options.apiKey) {
        console.log(chalk.blue('🔑 Setting API key...'));
        const sdkEndpoint = saveGlobalApiKey(options.apiKey, resolvedBaseUrl);
        console.log(chalk.green('✅ API key set successfully!'));
        console.log(chalk.yellow('🔑 Your API Key:'), chalk.cyan(options.apiKey));
        console.log(chalk.gray(`   Active context: ${resolvedBaseUrl}${sdkEndpoint ? ` (SDK_ENDPOINT: ${sdkEndpoint})` : ''}`));
        console.log(chalk.green(`💾 Saved to ${GLOBAL_CREDENTIALS_PATH} - every project on this machine now targets this server.`));
        return;
      }

      // Only the browser flow needs a web app URL - fetch it from the backend itself (not needed/
      // fetched for --basic, which never touches AIVIN_WEB_URL at all). Same override precedence
      // as everywhere else: a caller-set AIVIN_WEB_URL (project .env/shell) always wins.
      if (!options.basic && !process.env.AIVIN_WEB_URL) {
        const webUrl = await fetchWebUrl(resolvedBaseUrl);
        if (webUrl) process.env.AIVIN_WEB_URL = webUrl;
      }

      const apiKey = options.basic ? await basicLogin(options) : await browserLogin();

      console.log(chalk.green('✅ Login successful!'));
      const sdkEndpoint = saveGlobalApiKey(apiKey, resolvedBaseUrl);
      console.log(chalk.gray(`   Active context: ${resolvedBaseUrl}${sdkEndpoint ? ` (SDK_ENDPOINT: ${sdkEndpoint})` : ''}`));
      console.log(chalk.green(`💾 Saved to ${GLOBAL_CREDENTIALS_PATH} - every project on this machine now targets this server.`));
    } catch (error) {
      console.log(chalk.red('❌ Login failed:'), error.message);
      process.exit(1);
    }
  });

// ── API key management - named keys for your account, separate from `aivin login`'s one ───────
//
// `aivin login` mints exactly one machine-wide key named after this hostname. These commands
// manage arbitrary named keys on the same account (e.g. one per CI pipeline, one per teammate's
// script) via the same `/apikey` endpoints the web app's Settings > API Keys tab and `aivin
// login`'s device-key replacement already use - authenticated with the API_KEY already saved by
// `aivin login`, not a fresh email/password prompt (see ApiKeyController's `@AllowApiKey()` +
// AuthGuard's `request.apiKeyAuth` fallback on the backend).
//
// `key gen` still prompts for your account password even though it doesn't ask for email - minting
// a new key from an existing one is the one action here that could otherwise let an
// already-compromised key re-provision itself indefinitely after being revoked, so the backend
// requires this step-up proof before creating one. `key list`/`key revoke` never grant anything
// (read metadata / remove access only), so they need no such prompt.

function requireSavedApiKey() {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error('API_KEY not set - run `aivin login` first.');
  }
  return apiKey;
}

/**
 * The client id a key was minted under is baked right into it (`${client}-ak-<...>`, see
 * ApiKeyService.createApiKey/parseApiKeyBearer on the backend) - parse it out locally so `client`
 * is always shown even if the `/apikey/whoami` network call below fails.
 */
function parseApiKeyClient(apiKey) {
  const anchorIndex = apiKey.lastIndexOf('-ak-');
  return anchorIndex === -1 ? undefined : apiKey.substring(0, anchorIndex);
}

/**
 * Prints which account/client the saved API_KEY resolves to, so a gen/revoke/list failure (wrong
 * account, wrong client) is obvious up front instead of a confusing 401/403 further down. Never
 * fatal - a lookup failure here shouldn't block the actual command, just fall back to what's
 * derivable locally from the key string itself.
 */
async function logAccountIdentity(serverUrl, apiKey) {
  const localClient = parseApiKeyClient(apiKey);
  try {
    const res = await axios.get(`${serverUrl}/apikey/whoami`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const { email, client } = res.data || {};
    console.log(chalk.gray(`   Account: ${email || 'unknown'}  (client: ${client || localClient || 'unknown'})`));
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    console.log(chalk.gray(`   Client: ${localClient || 'unknown'}  (couldn't resolve account email: ${message})`));
  }
}

async function listRemoteApiKeys(serverUrl, apiKey) {
  const authHeaders = { headers: { Authorization: `Bearer ${apiKey}` } };
  // 100 is the backend's own max page size (ApiKeyController.listApiKeys clamps `limit` there) -
  // plenty for the "find my one named key" lookups these commands do, and for `key list` itself.
  const res = await axios.get(`${serverUrl}/apikey`, { ...authHeaders, params: { limit: 100 } });
  return res.data?.items || [];
}

async function findApiKeyByName(serverUrl, apiKey, name) {
  const items = await listRemoteApiKeys(serverUrl, apiKey);
  return items.find((k) => k.name === name);
}

async function generateApiKey(name) {
  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = requireSavedApiKey();
  const authHeaders = { headers: { Authorization: `Bearer ${apiKey}` } };
  await logAccountIdentity(serverUrl, apiKey);

  const { password } = await inquirer.prompt([
    {
      type: 'password',
      name: 'password',
      message: 'Account password:',
      mask: '*',
      validate: (input) => input.length > 0 || 'Password is required',
    },
  ]);

  try {
    // Replace, not accumulate - same behavior `aivin login` already relies on for its own device
    // key, so re-running `aivin key gen "ci"` doesn't pile up duplicate "ci" entries.
    const existing = await findApiKeyByName(serverUrl, apiKey, name);
    if (existing) {
      await axios.delete(`${serverUrl}/apikey/${existing.id || existing._id}`, authHeaders);
    }

    const keyRes = await axios.post(`${serverUrl}/apikey`, { name, password }, authHeaders);
    if (!keyRes.data?.plainKey) throw new Error('Response did not include an API key');
    return keyRes.data.plainKey;
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Failed to create API key: ${message}`, { cause: error });
  }
}

async function revokeApiKeyByName(name) {
  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = requireSavedApiKey();
  await logAccountIdentity(serverUrl, apiKey);

  let existing;
  try {
    existing = await findApiKeyByName(serverUrl, apiKey, name);
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Failed to look up API keys: ${message}`, { cause: error });
  }
  if (!existing) {
    throw new Error(`No API key named "${name}" found on your account.`);
  }

  try {
    const authHeaders = { headers: { Authorization: `Bearer ${apiKey}` } };
    await axios.delete(`${serverUrl}/apikey/${existing.id || existing._id}`, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Failed to revoke API key: ${message}`, { cause: error });
  }
}

const keyCommand = program.command('key').description('Manage named API keys for your account');

keyCommand
  .command('gen [name]')
  .description('Create (or replace) a named API key for your account - shown only once')
  .option('--save', 'Also save this key as this machine\'s default (~/.aivin/credentials), like `aivin login -k`')
  .action(async (name, options) => {
    try {
      name = await requireArg(name, { prompt: 'Name for this API key:', usage: 'Usage: aivin key gen <name>' });
      console.log(chalk.blue(`🔑 Creating API key "${name}"...`));
      const plainKey = await generateApiKey(name);
      console.log(chalk.green('✅ API key created!'));
      console.log(chalk.yellow('🔑 Key:'), chalk.cyan(plainKey));
      console.log(chalk.gray('   This is shown only once - store it somewhere safe.'));
      if (options.save) {
        saveGlobalApiKey(plainKey);
        console.log(chalk.green(`💾 Saved to ${GLOBAL_CREDENTIALS_PATH} - every project on this machine can use it now.`));
      }
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

keyCommand
  .command('revoke [name]')
  .description('Revoke a named API key for your account')
  .action(async (name) => {
    try {
      name = await requireArg(name, { prompt: 'Name of the API key to revoke:', usage: 'Usage: aivin key revoke <name>' });
      console.log(chalk.blue(`🔑 Revoking API key "${name}"...`));
      await revokeApiKeyByName(name);
      console.log(chalk.green(`✅ API key "${name}" revoked.`));
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

keyCommand
  .command('list')
  .description('List API keys on your account')
  .action(async () => {
    try {
      const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
      const apiKey = requireSavedApiKey();
      await logAccountIdentity(serverUrl, apiKey);
      const items = await listRemoteApiKeys(serverUrl, apiKey);
      if (items.length === 0) {
        console.log(chalk.gray('No API keys found.'));
        return;
      }
      items.forEach((k) => {
        const created = k.created_at ? new Date(k.created_at).toISOString() : 'unknown';
        console.log(`  ${chalk.cyan(k.name)}  ${chalk.gray(`(created ${created})`)}`);
      });
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

// ── Missions, automation jobs, tasks, and workspace/project selection ─────────────────────────
//
// `aivin do` / `aivin do job` / `aivin task` are thin CLI wrappers over the same platform
// endpoints the web app's chat/automation/task UIs already use (`/agent/start-work`,
// `/automation/jobs/create`, `/task/create`) - not a new mechanism, just a terminal-native way to
// reach them with the already-saved API_KEY. All three default to your personal workspace when
// --workspace is omitted, since GET /workspace/list always returns the caller's Personal
// workspace first (see WorkspaceService.listWorkspace on the backend).

function missionAuthHeaders() {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }
  // `x-client-slug` - required for any request hitting the API host directly (no browser
  // Origin/Referer for TrustDomainService to map): checkRegisteredClient falls back to the Host
  // header otherwise (e.g. "beta_api_aivin_vn"), which never matches a real registered_clients
  // entry - not a missing-tenant error, just a gap between "FE calls via its own domain" (has an
  // Origin) and "CLI/SDK calls the API host directly" (nothing to map but this header). Same fix
  // as test-sdk's mintCap.ts applies for its own direct calls.
  const clientSlug = apiKey ? parseApiKeyClient(apiKey) : undefined;
  return {
    headers: {
      Authorization: `Bearer ${apiKey || 'dev-token'}`,
      ...(clientSlug ? { 'x-client-slug': clientSlug } : {}),
    },
  };
}

function missionServerUrl() {
  return process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
}

async function listWorkspaces(serverUrl, authHeaders) {
  let res;
  try {
    res = await axios.get(`${serverUrl}/workspace/list`, authHeaders);
  } catch (error) {
    // axios leaves `error.message` empty for some connection-level failures (e.g. ECONNREFUSED) -
    // fall back to `error.code` so this never surfaces as a bare, content-free "❌ ".
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Couldn't reach ${serverUrl} to look up workspaces: ${message}`, { cause: error });
  }
  return Array.isArray(res.data) ? res.data : res.data?.items || [];
}

/**
 * workspaces[0] IS "your personal workspace" whenever --workspace is omitted - the backend always
 * unshifts the caller's Personal workspace to the front of GET /workspace/list's response.
 */
async function resolveWorkspace(serverUrl, authHeaders, explicitId) {
  const workspaces = await listWorkspaces(serverUrl, authHeaders);
  if (explicitId) {
    const match = workspaces.find((w) => (w.id || w._id) === explicitId);
    if (!match) throw new Error(`Workspace "${explicitId}" not found or not accessible.`);
    return match;
  }
  const personal = workspaces[0];
  if (!personal) throw new Error('No workspace found for this account. Pass --workspace <id>.');
  return personal;
}

/**
 * A workspace's `agents` array always has its client's default AI Staff agent unshifted to the
 * front (see WorkspaceService.assembleEnrichedWorkspace) - so agents[0] is a sensible default
 * whenever --agent is omitted, same reasoning as resolveWorkspace's workspaces[0].
 */
function resolveAgentId(workspace, explicitAgentId) {
  if (explicitAgentId) return explicitAgentId;
  const agentId = workspace.agents?.[0]?.id || workspace.agents?.[0]?.agent_id;
  if (!agentId) {
    throw new Error(`Workspace "${workspace.name || workspace.id}" has no agent to run as - pass --agent <id>.`);
  }
  return agentId;
}

// ── AI Staff agents - marketplace search, install into a workspace, create, publish ────────────

async function searchAgents(serverUrl, authHeaders, { query, workspaceId, limit } = {}) {
  const params = {};
  if (query) params.query = query;
  if (workspaceId) params.workspace_id = workspaceId;
  if (limit) params.limit = limit;
  let response;
  try {
    response = await axios.get(`${serverUrl}/ai-staff/search`, { ...authHeaders, params });
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Agent search failed: ${message}`, { cause: error });
  }
  const data = response.data;
  return Array.isArray(data) ? data : data?.items || [];
}

async function pullAgentIntoWorkspace(serverUrl, authHeaders, { agentId, workspaceId }) {
  try {
    await axios.post(`${serverUrl}/ai-staff/pull`, { agent_id: agentId, workspace_id: workspaceId }, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to install agent into workspace: ${message}`, { cause: error });
  }
}

async function createAgent(serverUrl, authHeaders, { name, nickname, email, bio, workspaceId }) {
  let response;
  try {
    response = await axios.post(
      `${serverUrl}/ai-staff/create`,
      { name, nickname, email, bio, original_workspace_id: workspaceId },
      authHeaders,
    );
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to create agent: ${message}`, { cause: error });
  }
  return response.data ?? {};
}

async function publishAgent(serverUrl, authHeaders, { agentId, workspaceId }) {
  try {
    await axios.post(`${serverUrl}/ai-staff/update`, { id: agentId, workspace_id: workspaceId, is_published: true }, authHeaders);
    await axios.post(`${serverUrl}/ai-staff/push`, { agent_id: agentId, workspace_id: workspaceId }, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to publish agent: ${message}`, { cause: error });
  }
}

/**
 * Interactively resolves which agent `aivin do` should run as: matches `agentNickname` against
 * the workspace's already-installed agents (by nickname/name/id) if given, otherwise prompts to
 * pick one. If the nickname doesn't match anything, or the workspace has no agents at all yet,
 * offers to search-and-install one from the marketplace or create a brand new one, so `aivin do`
 * never dead-ends just because a workspace hasn't been set up with an agent yet.
 */
async function resolveAgentInteractive(serverUrl, authHeaders, workspace, agentNickname) {
  const agents = workspace.agents || [];
  const workspaceId = workspace.id || workspace._id;

  if (agentNickname) {
    const match = agents.find((a) => a.nickname === agentNickname || a.id === agentNickname || a.name === agentNickname);
    if (match) return match;
    console.log(chalk.yellow(`No agent named "${agentNickname}" found in workspace "${workspace.name}".`));
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error(
      agents.length > 0
        ? `Pass --agent <id> (one of: ${agents.map((a) => a.nickname || a.name || a.id).join(', ')}), or run this in an interactive terminal.`
        : `Workspace "${workspace.name}" has no agents - run \`aivin agent install\`/\`aivin agent make\` first, or run this in an interactive terminal.`,
    );
  }

  const NEW_AGENT_ACTIONS = {
    INSTALL: '__install__',
    CREATE: '__create__',
  };

  if (agents.length === 0) {
    console.log(chalk.gray(`Workspace "${workspace.name}" has no agents yet.`));
    const { action } = await inquirer.prompt([
      {
        type: 'select',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: 'Search & install an agent from the marketplace', value: NEW_AGENT_ACTIONS.INSTALL },
          { name: 'Create a brand new agent', value: NEW_AGENT_ACTIONS.CREATE },
        ],
      },
    ]);
    return action === NEW_AGENT_ACTIONS.INSTALL
      ? installAgentInteractive(serverUrl, authHeaders, workspaceId)
      : createAgentInteractive(serverUrl, authHeaders, workspaceId);
  }

  const choices = [
    ...agents.map((a) => ({ name: a.nickname || a.name || a.id, value: a.id || a.agent_id })),
    { name: chalk.gray('+ Search & install a different agent from the marketplace'), value: NEW_AGENT_ACTIONS.INSTALL },
    { name: chalk.gray('+ Create a brand new agent'), value: NEW_AGENT_ACTIONS.CREATE },
  ];
  const { pickedAgentId } = await inquirer.prompt([
    { type: 'select', name: 'pickedAgentId', message: 'Which agent should run this?', choices },
  ]);
  if (pickedAgentId === NEW_AGENT_ACTIONS.INSTALL) return installAgentInteractive(serverUrl, authHeaders, workspaceId);
  if (pickedAgentId === NEW_AGENT_ACTIONS.CREATE) return createAgentInteractive(serverUrl, authHeaders, workspaceId);
  return agents.find((a) => (a.id || a.agent_id) === pickedAgentId);
}

async function installAgentInteractive(serverUrl, authHeaders, workspaceId) {
  const { query } = await inquirer.prompt([
    { type: 'input', name: 'query', message: 'Search the marketplace for an agent:', validate: (v) => v.trim().length > 0 || 'Required' },
  ]);
  const results = await searchAgents(serverUrl, authHeaders, { query, workspaceId, limit: 10 });
  if (results.length === 0) {
    throw new Error(`No marketplace agents found matching "${query}".`);
  }
  const { pickedAgent } = await inquirer.prompt([
    {
      type: 'select',
      name: 'pickedAgent',
      message: 'Install which agent?',
      choices: results.map((a) => ({ name: `${a.nickname || a.name}${a.bio ? chalk.gray(`  - ${a.bio}`) : ''}`, value: a })),
    },
  ]);
  await pullAgentIntoWorkspace(serverUrl, authHeaders, { agentId: pickedAgent.id, workspaceId });
  console.log(chalk.green(`✅ Installed "${pickedAgent.nickname || pickedAgent.name}" into this workspace.`));
  return pickedAgent;
}

async function createAgentInteractive(serverUrl, authHeaders, workspaceId) {
  const answers = await inquirer.prompt([
    { type: 'input', name: 'name', message: 'Agent name:', validate: (v) => v.trim().length > 0 || 'Required' },
    { type: 'input', name: 'nickname', message: 'Agent nickname (used to @-mention/target it):', validate: (v) => v.trim().length > 0 || 'Required' },
    { type: 'input', name: 'email', message: 'Agent email:', validate: (v) => v.trim().length > 0 || 'Required' },
    { type: 'input', name: 'bio', message: 'Short bio (optional):' },
  ]);
  const agent = await createAgent(serverUrl, authHeaders, { ...answers, workspaceId });
  console.log(chalk.green(`✅ Created agent "${agent.nickname || agent.name}".`));
  return agent;
}

// Every mission/job/task run logs its progress over the same clientLog() Socket.IO channel the
// web app's chat/automation/task panels already listen on - the event name depends on which
// `execution_channel` the run is on, so we just listen on all of them and filter by thread_id.
const MISSION_LOG_EVENTS = ['chat-log', 'agent-log', 'automation-log', 'task-agent-log'];
// The only two event_keys FlowService emits for a *whole* run finishing (not just one stage) -
// see docs/sdk/automation.md's caveats section for why there's no generic "job succeeded" signal
// beyond this on the wire.
const MISSION_DONE_EVENT_KEYS = new Set(['flow.completed', 'flow.error', 'runner.start_failed']);

/**
 * Streams realtime progress for a running mission/job/task, for a nicer `aivin do` experience than
 * a bare HTTP response - connects to the same Socket.IO channel `aivin plugin logs` already uses
 * (see streamPluginLogs above), no explicit subscribe call needed since clientLog() emits to the
 * caller's own user room automatically. Resolves on a recognized terminal event_key, on idle
 * timeout, or on Ctrl+C - whichever comes first. Never throws: a log-streaming hiccup shouldn't
 * fail a command whose HTTP call already succeeded.
 */
function streamMissionLog(serverUrl, apiKey, threadId, { idleTimeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const socket = io(serverUrl, {
      auth: { token: apiKey || 'dev-token' },
      transports: ['websocket'],
      reconnection: true,
    });

    let idleTimer;
    let settled = false;
    const statusIcon = (status) =>
      status === 'error'
        ? chalk.red('✗')
        : status === 'success'
          ? chalk.green('✓')
          : status === 'warning'
            ? chalk.yellow('!')
            : chalk.gray('·');

    const stop = () => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      socket.disconnect();
      process.off('SIGINT', stop);
      resolve();
    };

    const bumpIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.log(
          chalk.gray(
            `\n(no activity for ${Math.round(idleTimeoutMs / 1000)}s - stopped watching; the run may still be going in the background)`,
          ),
        );
        stop();
      }, idleTimeoutMs);
    };

    process.on('SIGINT', stop);

    socket.on('connect_error', (error) => {
      console.log(chalk.yellow(`⚠️  Couldn't watch live progress (${error.message}) - the run continues regardless.`));
      stop();
    });

    for (const eventName of MISSION_LOG_EVENTS) {
      socket.on(eventName, (payload) => {
        if (!payload || payload.thread_id !== threadId) return;
        bumpIdleTimer();
        const time = new Date(payload.timestamp || Date.now()).toLocaleTimeString();
        const label = payload.event_key || eventName;
        console.log(
          `${chalk.gray(`[${time}]`)} ${statusIcon(payload.status)} ${chalk.gray(label)} ${payload.message || ''}`.trimEnd(),
        );
        if (MISSION_DONE_EVENT_KEYS.has(payload.event_key)) stop();
      });
    }

    console.log(chalk.gray(`📡 Watching live progress for ${threadId}... (Ctrl+C to stop watching - the run keeps going either way)\n`));
    bumpIdleTimer();
  });
}

// ── `aivin browser` - dedicated AI Browser trigger with a real interactive viewer for HIL ──────
//
// Unlike `sdk.browser.run()`/`runStream()` (code-plugin escape hatch, deliberately refuses to
// suspend on HIL - see docs/sdk/browser.md), this goes through the SAME `/agent/start-work` path
// `aivin do` uses, because that's the only trigger path wired to the real BullMQ suspend/resume
// plumbing (`PluginBridge.trigger()`) - `/plugins/execute` (what `aivin plugin trigger` calls)
// does NOT catch HilSuspendSignal at all and would just 500 on a mission that needs a human.
// The mission prompt is prefixed to bias the agent's own NLU tool-selection toward AI Browser
// specifically (not a hard guarantee - there's no "force this exact tool" param exposed on
// start-work today - but reliable in practice for an unambiguous browser-shaped mission).
const BROWSER_MISSION_PREFIX =
  'Use the AI Browser tool (official.ai_browser) to accomplish the following mission directly - do not just describe how, actually browse: ';

/**
 * Self-contained viewer page: connects to the SAME Socket.IO channel the web app's HIL screencast
 * panel uses (AIBrowserGateway/AIBrowserScreencastService), renders the live CDP frame stream
 * fullscreen on a <canvas>, and relays mouse/keyboard back as `browser:click`/`type`/`scroll`/...
 * - the exact same wire protocol, just a purpose-built fullscreen client instead of the chat UI's
 * embedded panel. `token`/`client` are injected server-side (this file is generated fresh per
 * `aivin browser` run, never written to disk) - not exposed via query string, which would leak
 * into shell history/proxy logs/browser history.
 */
function browserViewerHtml({ serverUrl, apiKey, tenantClient }) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>aivin browser - live session</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #111; overflow: hidden; }
  #status { position: fixed; top: 0; left: 0; right: 0; padding: 8px 14px; background: rgba(0,0,0,.7);
            color: #eee; font: 13px/1.4 -apple-system, Segoe UI, sans-serif; z-index: 10; display: flex;
            justify-content: space-between; align-items: center; }
  #status button { background: #2563eb; color: #fff; border: none; padding: 6px 14px; border-radius: 6px;
                    font-size: 13px; cursor: pointer; }
  #status button:hover { background: #1d4ed8; }
  #stage { position: fixed; top: 0; left: 0; width: 100%; height: 100%; display: flex;
           align-items: center; justify-content: center; }
  canvas { cursor: default; box-shadow: 0 0 40px rgba(0,0,0,.6); }
  #waiting { color: #888; font: 15px -apple-system, Segoe UI, sans-serif; text-align: center; }
</style>
</head>
<body>
<div id="status">
  <span id="statusText">Đang kết nối...</span>
  <button id="doneBtn" style="display:none">✅ Xong - tiếp tục mission</button>
</div>
<div id="stage"><div id="waiting">Đang chờ mission mở phiên tương tác (HIL)...</div></div>
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<script>
(function () {
  const serverUrl = ${JSON.stringify(serverUrl)};
  const apiKey = ${JSON.stringify(apiKey)};
  const tenantClient = ${JSON.stringify(tenantClient)};
  const statusText = document.getElementById('statusText');
  const doneBtn = document.getElementById('doneBtn');
  const stage = document.getElementById('stage');

  let sessionKey = null;
  let canvas = null, ctx = null;
  let viewportW = 1280, viewportH = 800;

  const socket = io(serverUrl, { auth: { token: apiKey }, transports: ['websocket'], reconnection: true });

  socket.on('connect_error', (e) => { statusText.textContent = 'Lỗi kết nối: ' + e.message; });
  socket.on('connect', () => { statusText.textContent = 'Đã kết nối - chờ phiên tương tác cho ' + tenantClient + '...'; });

  function ensureCanvas() {
    if (canvas) return;
    stage.innerHTML = '';
    canvas = document.createElement('canvas');
    canvas.width = viewportW;
    canvas.height = viewportH;
    fitCanvas();
    stage.appendChild(canvas);
    ctx = canvas.getContext('2d');
    wireInput();
  }

  function fitCanvas() {
    if (!canvas) return;
    const availW = window.innerWidth, availH = window.innerHeight - 40;
    const scale = Math.min(availW / viewportW, availH / viewportH, 1);
    canvas.style.width = Math.round(viewportW * scale) + 'px';
    canvas.style.height = Math.round(viewportH * scale) + 'px';
  }
  window.addEventListener('resize', fitCanvas);

  socket.on('browser:cast-start', (payload) => {
    sessionKey = payload.clientId;
    viewportW = payload.viewportWidth || 1280;
    viewportH = payload.viewportHeight || 800;
    statusText.textContent = 'Phiên tương tác: ' + sessionKey + ' (' + (payload.url || '') + ')';
    doneBtn.style.display = 'inline-block';
    socket.emit('join-room', { name: 'aivin-cli', rooms: ['aibrowser:' + sessionKey] });
    ensureCanvas();
  });

  socket.on('browser:screenshot', (payload) => {
    if (!payload || !payload.screenshot) return;
    ensureCanvas();
    const bytes = payload.screenshot instanceof ArrayBuffer ? new Uint8Array(payload.screenshot) : payload.screenshot;
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); URL.revokeObjectURL(url); };
    img.src = url;
    if (payload.title) statusText.textContent = payload.title + '  —  ' + (payload.url || '');
  });

  socket.on('browser:cast-error', (payload) => {
    statusText.textContent = '⚠️ ' + (payload.reason || 'Mất kết nối phiên trình duyệt');
  });

  socket.on('browser:resolved', () => {
    statusText.textContent = '✅ Đã gửi tín hiệu hoàn tất - mission đang tiếp tục...';
    doneBtn.style.display = 'none';
  });

  doneBtn.addEventListener('click', () => {
    if (!sessionKey) return;
    socket.emit('browser:resolve', { clientId: sessionKey, option: 'approve' });
  });

  function toPageCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * (viewportW / rect.width));
    const y = Math.round((e.clientY - rect.top) * (viewportH / rect.height));
    return { x, y };
  }

  const SPECIAL_KEYS = {
    Enter: '__ENTER__', Backspace: '__BACKSPACE__', Delete: '__DELETE__', Tab: '__TAB__',
    Escape: '__ESCAPE__', ArrowUp: '__ARROW_UP__', ArrowDown: '__ARROW_DOWN__',
    ArrowLeft: '__ARROW_LEFT__', ArrowRight: '__ARROW_RIGHT__', Home: '__HOME__', End: '__END__',
    PageUp: '__PAGE_UP__', PageDown: '__PAGE_DOWN__', F5: '__F5__', F12: '__F12__',
  };

  function wireInput() {
    canvas.addEventListener('click', (e) => {
      if (!sessionKey) return;
      const { x, y } = toPageCoords(e);
      socket.emit('browser:click', { clientId: sessionKey, x, y });
    });
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!sessionKey) return;
      const { x, y } = toPageCoords(e);
      socket.emit('browser:rightclick', { clientId: sessionKey, x, y });
    });
    canvas.addEventListener('dblclick', (e) => {
      if (!sessionKey) return;
      const { x, y } = toPageCoords(e);
      socket.emit('browser:dblclick', { clientId: sessionKey, x, y });
    });
    let lastHover = 0;
    canvas.addEventListener('mousemove', (e) => {
      if (!sessionKey) return;
      const now = Date.now();
      if (now - lastHover < 50) return;
      lastHover = now;
      const { x, y } = toPageCoords(e);
      socket.emit('browser:hover', { clientId: sessionKey, x, y });
    });
    canvas.addEventListener('wheel', (e) => {
      if (!sessionKey) return;
      e.preventDefault();
      socket.emit('browser:scroll', { clientId: sessionKey, deltaY: e.deltaY });
    }, { passive: false });
    canvas.tabIndex = 0;
    canvas.addEventListener('keydown', (e) => {
      if (!sessionKey) return;
      if (e.ctrlKey || e.metaKey) return; // let browser-level shortcuts (devtools, refresh...) through
      const special = SPECIAL_KEYS[e.key];
      if (special) {
        e.preventDefault();
        socket.emit('browser:type', { clientId: sessionKey, text: special });
        return;
      }
      if (e.key.length === 1) {
        e.preventDefault();
        socket.emit('browser:type', { clientId: sessionKey, text: e.key });
      }
    });
    canvas.addEventListener('mouseenter', () => canvas.focus());
  }
})();
</script>
</body>
</html>`;
}

/**
 * Serves the viewer page on a random local port (127.0.0.1 only - never exposed beyond this
 * machine) and opens it in the default OS browser. The HTTP server is torn down when the CLI
 * process exits (SIGINT/mission end) - it only needs to live for the duration of `aivin browser`.
 */
function openBrowserViewer(serverUrl, apiKey, tenantClient) {
  return new Promise((resolve) => {
    const html = browserViewerHtml({ serverUrl, apiKey, tenantClient });
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/`;
      console.log(chalk.cyan(`\n🖥️  Mở phiên tương tác trực tiếp: ${url}`));
      openBrowser(url);
      resolve(server);
    });
  });
}

/**
 * Same live-progress watcher as `streamMissionLog`, plus: on the first `ai_browser.hil_required`
 * event (mission hit a step that needs a human - captcha, login, free-text confirmation), opens
 * the fullscreen viewer automatically instead of leaving the user to go find it. Only opens once
 * per run even if HIL fires again later (e.g. a second captcha) - the SAME viewer page keeps
 * working across multiple HIL rounds since it just reacts to whatever `browser:cast-start` fires
 * next on this tenant's room.
 */
function streamBrowserMissionLog(serverUrl, apiKey, threadId, tenantClient, { idleTimeoutMs = 120_000, openViewerOnHIL = true } = {}) {
  return new Promise((resolve) => {
    const socket = io(serverUrl, { auth: { token: apiKey || 'dev-token' }, transports: ['websocket'], reconnection: true });

    let idleTimer;
    let settled = false;
    let viewerOpened = false;
    const statusIcon = (status) =>
      status === 'error' ? chalk.red('✗') : status === 'success' ? chalk.green('✓') : status === 'warning' ? chalk.yellow('!') : chalk.gray('·');

    const stop = () => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      socket.disconnect();
      process.off('SIGINT', stop);
      resolve();
    };

    const bumpIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.log(chalk.gray(`\n(no activity for ${Math.round(idleTimeoutMs / 1000)}s - stopped watching; the run may still be going in the background)`));
        stop();
      }, idleTimeoutMs);
    };

    process.on('SIGINT', stop);

    socket.on('connect_error', (error) => {
      console.log(chalk.yellow(`⚠️  Couldn't watch live progress (${error.message}) - the run continues regardless.`));
      stop();
    });

    for (const eventName of MISSION_LOG_EVENTS) {
      socket.on(eventName, (payload) => {
        if (!payload || payload.thread_id !== threadId) return;
        bumpIdleTimer();
        const time = new Date(payload.timestamp || Date.now()).toLocaleTimeString();
        const label = payload.event_key || eventName;
        console.log(`${chalk.gray(`[${time}]`)} ${statusIcon(payload.status)} ${chalk.gray(label)} ${payload.message || ''}`.trimEnd());

        if (payload.event_key === 'ai_browser.hil_required' && !viewerOpened) {
          viewerOpened = true;
          // Most important moment for a notification: a mission can run for minutes with the
          // terminal/browser out of focus, and this is the one point where it's actually STUCK until
          // the user comes back - not just a progress update they can catch up on later.
          sendOSNotification('AI Browser cần bạn hỗ trợ', payload.message || 'Mission đang chờ bạn tương tác');
          if (openViewerOnHIL) {
            console.log(chalk.magenta('\n👤 Mission cần bạn tương tác trực tiếp (captcha/đăng nhập/xác nhận) - đang mở trình duyệt...'));
            openBrowserViewer(serverUrl, apiKey, tenantClient).catch((e) =>
              console.log(chalk.yellow(`⚠️  Không mở được viewer tự động: ${e.message} - thử lại bằng \`aivin browser --view ${tenantClient}\`.`)),
            );
          } else {
            // Local mode: no separate viewer needed at all - the message + a "Xong" button are
            // injected directly onto the real tab the user is already looking at (AIBrowserService's
            // showOnPageHILBanner). A screencast-based viewer here would just be a second, redundant,
            // lower-fidelity copy of a page already fully visible natively.
            console.log(chalk.magenta(`\n👤 ${payload.message || 'Mission cần bạn hỗ trợ'} - kiểm tra cửa sổ trình duyệt (có banner xanh ở đầu trang), bấm "Xong" ở đó khi hoàn tất.`));
          }
        }
        // `execute-interactive` calls triggerMission directly (not the multi-step `flow.*` runner
        // aivin do's missions go through), so its real terminal signal is ai_browser.success/failed,
        // not anything in MISSION_DONE_EVENT_KEYS - checked in addition to (not instead of) that set
        // since this function is also reused as a fallback for --remote missions triggered elsewhere.
        if (payload.event_key === 'ai_browser.success' || payload.event_key === 'ai_browser.failed' || MISSION_DONE_EVENT_KEYS.has(payload.event_key)) {
          const ok = payload.event_key !== 'ai_browser.failed' && payload.status !== 'error';
          sendOSNotification(ok ? '✅ AI Browser hoàn tất' : '❌ AI Browser thất bại', payload.message || '');
          stop();
        }
      });
    }

    // 🔍 Step-by-step agentic detail (perceive/plan/execute/audit/recover) - a SEPARATE Socket.IO
    // room-broadcast event from the chat-log-shaped ones above (AIBrowserService.emitAgentStep,
    // room `client:<tenant>`, joined automatically on auth per SocketIO.ts). Was previously never
    // listened to here at all - the terminal only ever showed the bookend start/success/failed lines
    // even though the backend was emitting a full trace the whole time. `detail` (when present)
    // carries the LLM's actual per-action reasoning (AIBrowserActionItem.reason), not just the
    // truncated one-line summary meant for a chat bubble.
    const STEP_ICON = { perceiving: '👁', executing: '▶', blocked: '🛡', recovering: '↺', auditing: '🔎', done: '✅', failed: '❌' };
    socket.on('browser:agent-step', (payload) => {
      if (!payload) return;
      bumpIdleTimer();
      const time = new Date().toLocaleTimeString();
      const icon = STEP_ICON[payload.type] || '·';
      console.log(`${chalk.gray(`[${time}]`)} ${icon} ${chalk.cyan(`step ${payload.step}`)} ${chalk.gray(payload.type)} ${payload.summary || ''}`.trimEnd());
      if (payload.url) console.log(chalk.gray(`         url: ${payload.url}`));
      const detail = payload.detail;
      if (Array.isArray(detail)) {
        // 'executing' - one or more planned actions, each with its own reasoning
        for (const a of detail) {
          console.log(chalk.gray(`         - ${a.type}${a.detail ? ` (${a.detail})` : ''}`));
          if (a.reason) console.log(chalk.dim(`           reason: ${a.reason}`));
        }
      } else if (detail && typeof detail === 'object') {
        // 'recovering' - { reason, revisedActions } from the audit/replan phase
        if (detail.reason) console.log(chalk.dim(`         reason: ${detail.reason}`));
        for (const a of detail.revisedActions || []) {
          console.log(chalk.gray(`         - ${a.type}${a.detail ? ` (${a.detail})` : ''}`));
          if (a.reason) console.log(chalk.dim(`           reason: ${a.reason}`));
        }
      }
    });

    console.log(chalk.gray(`📡 Watching live progress for ${threadId}... (Ctrl+C to stop watching - the run keeps going either way)\n`));
    bumpIdleTimer();
  });
}

// ── `aivin browser` default mode: drive the user's OWN local, already-running browser ──────────
//
// Real cookies/logins, real fingerprint - much better bot-detection resistance than the server-
// side pooled browser `--remote` uses. Architecture: a raw WebSocket relay on the backend
// (BrowserTunnelRelay) pairs this CLI's connection to the user's local Chrome CDP endpoint with
// AIBrowserService's own `BrowserIO.connect(...)` call server-side - the EXISTING agentic loop
// (causality, bot-guard, semantic matching, HIL) drives that real browser unmodified, this file
// only ever pipes opaque frames, never inspects them.

const BROWSER_CLI_AGENT_CACHE_PATH = path.join(os.homedir(), '.aivin', 'browser-cli-agents.json');
// A separate Chrome/Edge profile dedicated to `aivin browser`, NOT the user's real daily-driver
// profile. Reasoning (confirmed the hard way): `--remote-debugging-port` can only be set at process
// launch, never toggled on an already-running instance, AND Chromium's single-instance-per-profile
// lock means launching a second process against the SAME profile the user is already using just
// silently forwards to the existing (non-debuggable) instance instead of actually starting a new,
// debuggable one - so reusing the daily-driver profile meant demanding the user close every window
// first, every single time. A dedicated profile sidesteps all of that: it can launch/stay running
// fully independently of whatever the user's main browser is doing, at the cost of a one-time login
// (Facebook etc.) the first time it's used - after that, cookies persist here just like any profile.
const AIVIN_BROWSER_PROFILE_DIR = path.join(os.homedir(), '.aivin', 'browser-profile');

// Without a `start_url`, the mission's first step lands on a totally blank page - confirmed while
// testing this to cost real time (a full perceive+plan cycle wasted on a page with nothing to look
// at) AND to be a correctness risk: with nothing to navigate to, the planner reaches for the `search`
// action to find the target site itself, which does a REAL web search and goes wherever the top
// (reranked) result is - watched it once land on an unrelated w3schools tutorial page instead of
// facebook.com. A `start_url` sidesteps both: the mission opens directly on the real site via a plain
// `page.goto` before the agentic loop even starts, no guessing involved. Best-effort keyword match
// only (not NLU) - covers the common case from a mission mentioning a well-known site by name; falls
// back to no start_url (today's behavior) when nothing matches, and --url always wins outright.
const KNOWN_SITE_HINTS = [
  { re: /facebook|\bfb\b/i, url: 'https://www.facebook.com' },
  { re: /instagram|\big\b/i, url: 'https://www.instagram.com' },
  { re: /\btiktok\b/i, url: 'https://www.tiktok.com' },
  { re: /\byoutube\b/i, url: 'https://www.youtube.com' },
  { re: /\b(twitter|x\.com)\b/i, url: 'https://x.com' },
  { re: /linkedin/i, url: 'https://www.linkedin.com' },
  { re: /\bzalo\b/i, url: 'https://chat.zalo.me' },
  { re: /\bgmail\b/i, url: 'https://mail.google.com' },
  { re: /\boutlook\b/i, url: 'https://outlook.live.com' },
  // Vietnamese e-commerce/social - the realistic mission targets for this CLI's actual audience,
  // not just the generic global-site list above.
  { re: /\bshopee\b/i, url: 'https://shopee.vn' },
  { re: /\btiki\b/i, url: 'https://tiki.vn' },
  { re: /\blazada\b/i, url: 'https://www.lazada.vn' },
  { re: /\bsendo\b/i, url: 'https://www.sendo.vn' },
  { re: /\bvnexpress\b/i, url: 'https://vnexpress.net' },
  { re: /\bamazon\b/i, url: 'https://www.amazon.com' },
  { re: /\bgithub\b/i, url: 'https://github.com' },
  { re: /\breddit\b/i, url: 'https://www.reddit.com' },
  { re: /\bpinterest\b/i, url: 'https://www.pinterest.com' },
  { re: /\bthreads\b/i, url: 'https://www.threads.net' },
  { re: /\bwhatsapp\b/i, url: 'https://web.whatsapp.com' },
  { re: /\btelegram\b/i, url: 'https://web.telegram.org' },
  { re: /\bdiscord\b/i, url: 'https://discord.com' },
  { re: /\bspotify\b/i, url: 'https://open.spotify.com' },
  { re: /\bnetflix\b/i, url: 'https://www.netflix.com' },
];

// Fallback for a site NOT in the (necessarily always-incomplete) list above: if the mission text
// itself contains something that looks like an actual domain (e.g. "đăng nhập vào crm.mycompany.vn"),
// use that directly rather than leaving start_url unset - a hand-picked static list can never cover
// every real target, especially a mission naming an internal/niche/foreign site nobody thought to
// hardcode. Deliberately conservative: requires a real-looking TLD, not just any two words with a
// dot between them (avoids matching version numbers, decimals, "v1.2" etc.).
const DOMAIN_IN_TEXT_RE = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|vn|dev|app|shop|store|biz|info|edu|gov|xyz)(?:\.[a-z]{2,3})?)\b/i;
function guessStartUrl(mission) {
  const known = KNOWN_SITE_HINTS.find((h) => h.re.test(mission))?.url;
  if (known) return known;
  const domainMatch = DOMAIN_IN_TEXT_RE.exec(mission);
  return domainMatch ? `https://${domainMatch[1]}` : undefined;
}

// ── Windows toast identity: shows "AI Browser" + the real aivin icon instead of a bare, borrowed
// "File Explorer" notification ────────────────────────────────────────────────────────────────
//
// Confirmed by hand while building this: a plain AppUserModelId registry entry (DisplayName +
// IconUri, no shortcut) gets the NAME right but Windows silently ignores the IconUri for an
// unpackaged (non-MSIX) app - a known platform gap, not a bug in this setup. The icon only actually
// shows once a Start Menu shortcut exists whose System.AppUserModel.ID property (via IPropertyStore)
// matches the AUMID used in CreateToastNotifier - that requires COM interop (IShellLinkW +
// IPropertyStore), which plain PowerShell cmdlets don't expose, hence the embedded C# below compiled
// on demand via Add-Type. This whole block only ever runs ONCE per machine (skipped immediately if
// the shortcut already exists) - the compile is real but not a per-notification cost.
const AIVIN_NOTIF_AUMID = 'AivinBrowser.CLI';
const AIVIN_ICON_SOURCE_PNG = path.join(__dirname, 'assets', 'aivin-icon.png');
const AIVIN_ICON_ICO = path.join(os.homedir(), '.aivin', 'notification-icon.ico');

function windowsNotificationShortcutPath() {
  // %APPDATA%\Microsoft\Windows\Start Menu\Programs - same folder Start Menu search indexes,
  // matches what a real installer would use (this entry never needs to be launched by the user,
  // it exists purely to carry the AUMID + icon association).
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'AI Browser.lnk');
}

/** One-time (per machine), best-effort setup - PNG→ICO conversion + registry DisplayName + a Start
 *  Menu shortcut carrying the AUMID via COM IPropertyStore. Every step independently best-effort:
 *  a failure partway (e.g. propsys.dll COM call blocked by policy) just means the toast falls back
 *  to a plain/unbranded appearance later, never something worth failing a mission over. Synchronous
 *  (blocks briefly on first-ever notification only) - acceptable since it's a one-time cost in the
 *  context of a multi-minute mission, and notifications aren't on any latency-sensitive path. */
function ensureWindowsNotificationIdentity() {
  const shortcutPath = windowsNotificationShortcutPath();
  if (fs.existsSync(shortcutPath)) return; // already set up on this machine
  try {
    fs.mkdirSync(path.dirname(AIVIN_ICON_ICO), { recursive: true });
    const csharpSource = `
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class AivinShortcutAumid {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] internal class ShellLink { }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    internal interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszFile, int cchMaxPath, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl); void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszName, int cchMaxName);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszDir, int cchMaxPath);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszArgs, int cchMaxPath);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey); void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd); void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszIconPath, int cchIconPath, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }
    [StructLayout(LayoutKind.Sequential)] internal struct PROPERTYKEY { public Guid fmtid; public int pid; }
    [StructLayout(LayoutKind.Sequential)] internal struct PROPVARIANT { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public int p2; }
    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore {
        void GetCount(out uint cProps); void GetAt(uint iProp, out PROPERTYKEY pkey);
        void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv); void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        void Commit();
    }
    [DllImport("propsys.dll")] static extern int PSPropertyKeyFromString([MarshalAs(UnmanagedType.LPWStr)] string s, out PROPERTYKEY pkey);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pvar);
    public static void CreateWithAumid(string shortcutPath, string targetPath, string iconPath, string aumid) {
        var link = (IShellLinkW)new ShellLink();
        link.SetPath(targetPath);
        link.SetIconLocation(iconPath, 0);
        link.SetShowCmd(7);
        PROPERTYKEY pkey;
        if (PSPropertyKeyFromString("{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3} 5", out pkey) != 0) throw new Exception("PSPropertyKeyFromString failed");
        var pv = new PROPVARIANT();
        pv.vt = 31; // VT_LPWSTR
        pv.p = Marshal.StringToCoTaskMemUni(aumid);
        ((IPropertyStore)link).SetValue(ref pkey, ref pv);
        ((IPropertyStore)link).Commit();
        PropVariantClear(ref pv);
        ((IPersistFile)link).Save(shortcutPath, true);
    }
}`;
    const setupScript = [
      'Add-Type -AssemblyName System.Drawing',
      `if (-not (Test-Path $env:AIVIN_ICO_PATH)) {`,
      '  $png = [System.Drawing.Image]::FromFile($env:AIVIN_PNG_PATH)',
      '  $bmp = New-Object System.Drawing.Bitmap($png, 256, 256)',
      '  $ico = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())',
      '  $fs = New-Object System.IO.FileStream($env:AIVIN_ICO_PATH, [System.IO.FileMode]::Create)',
      '  $ico.Save($fs); $fs.Close(); $png.Dispose()',
      '}',
      `New-Item -Path "HKCU:\\Software\\Classes\\AppUserModelId\\${AIVIN_NOTIF_AUMID}" -Force | Out-Null`,
      `Set-ItemProperty -Path "HKCU:\\Software\\Classes\\AppUserModelId\\${AIVIN_NOTIF_AUMID}" -Name DisplayName -Value "AI Browser"`,
      `Add-Type -TypeDefinition @'\n${csharpSource}\n'@ -Language CSharp`,
      `[AivinShortcutAumid]::CreateWithAumid($env:AIVIN_SHORTCUT_PATH, "$env:WINDIR\\System32\\cmd.exe", $env:AIVIN_ICO_PATH, "${AIVIN_NOTIF_AUMID}")`,
    ].join('\n');
    execSync(`powershell.exe -NoProfile -NonInteractive -Command -`, {
      input: setupScript,
      env: {
        ...process.env,
        AIVIN_PNG_PATH: AIVIN_ICON_SOURCE_PNG,
        AIVIN_ICO_PATH: AIVIN_ICON_ICO,
        AIVIN_SHORTCUT_PATH: shortcutPath,
      },
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 15_000,
    });
  } catch {
    // best-effort only - toast still works via the Explorer-borrowed AppID fallback below,
    // just without aivin's own name/icon.
  }
}

/** Best-effort native OS notification - `aivin browser` (local mode) can run for minutes at a time
 *  with the user's attention elsewhere, and a HIL request in particular needs them to actually come
 *  back and look. Native per-OS command, no extra npm dependency (matches this file's existing
 *  pattern - registry reads, plutil, xdg-settings are all done the same way). Title/message passed
 *  via env vars (not string-interpolated into the script) specifically to avoid any shell/PowerShell/
 *  AppleScript quoting/injection concern - mission text and error messages both end up here and
 *  neither is trusted input. Never throws, never blocks - a failed notification is not worth
 *  interrupting a mission over. */
function sendOSNotification(title, message) {
  try {
    if (process.platform === 'win32') {
      ensureWindowsNotificationIdentity();
      // Windows 10/11 toast via the WinRT API directly - no extra module (BurntToast etc.) needed.
      // Uses the dedicated AUMID set up above once a shortcut backs it (falls back to Explorer's
      // borrowed identity harmlessly if that setup didn't succeed - CreateToastNotifier doesn't
      // validate the AUMID actually resolves to anything, it just shows less polished either way).
      const script = [
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
        "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
        "$t = [System.Security.SecurityElement]::Escape($env:AIVIN_NOTIF_TITLE)",
        "$m = [System.Security.SecurityElement]::Escape($env:AIVIN_NOTIF_MSG)",
        "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
        "$xml.LoadXml(\"<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$m</text></binding></visual></toast>\")",
        "$toast = New-Object Windows.UI.Notifications.ToastNotification($xml)",
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AIVIN_NOTIF_AUMID}').Show($toast)`,
      ].join('; ');
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, AIVIN_NOTIF_TITLE: title, AIVIN_NOTIF_MSG: message },
        stdio: 'ignore', detached: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      // `system attribute` reads the env var directly in AppleScript - sidesteps needing to escape
      // title/message into the script string at all.
      spawn('osascript', ['-e', 'display notification (system attribute "AIVIN_NOTIF_MSG") with title (system attribute "AIVIN_NOTIF_TITLE")'], {
        env: { ...process.env, AIVIN_NOTIF_TITLE: title, AIVIN_NOTIF_MSG: message },
        stdio: 'ignore', detached: true,
      }).unref();
    } else {
      // notify-send (freedesktop.org standard, most desktop distros ship it) - args array, not a
      // shell string, so no quoting concern here either.
      spawn('notify-send', [title, message], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // best-effort only
  }
}
// 9222 is Chrome/Edge's conventional remote-debugging port, but it's not reserved to them - anything
// can be listening there (found the hard way: this project's own local docker-compose stack publishes
// its headless Lightpanda container on host port 9222 too, for the unrelated `--remote` server-side
// browser pool). `probeLocalChromeDebugger` below verifies the `Browser` field before trusting a hit
// here, and `--debug-port` lets a real conflict just be sidestepped instead of fought.
const CHROME_DEBUG_PORT = 9222;

function loadBrowserCliAgentCache() {
  try {
    return JSON.parse(fs.readFileSync(BROWSER_CLI_AGENT_CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveBrowserCliAgentCache(cache) {
  fs.mkdirSync(path.dirname(BROWSER_CLI_AGENT_CACHE_PATH), { recursive: true });
  fs.writeFileSync(BROWSER_CLI_AGENT_CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

/**
 * `aivin browser` shouldn't require the user to know/pick an "agent" - AI Browser is what actually
 * does the work, the agent is just session/HIL identity plumbing the platform's data model requires
 * underneath. Creates one dedicated agent per workspace the first time, with `official.ai_browser`
 * already enabled, and caches its id so every later run is instant. Both API calls below (create,
 * then a second update call with `plugins.plugin_ids`) were verified working directly against the
 * API this session - `workspace_id` must be a query param on the update call (the DTO whitelists
 * it out of the body), and name/nickname/email must be repeated even though only `plugins` changed.
 */
async function resolveOrCreateBrowserAgent(serverUrl, authHeaders, workspace) {
  const workspaceId = workspace.id || workspace._id;
  const cache = loadBrowserCliAgentCache();
  const cachedId = cache[workspaceId];
  if (cachedId && workspace.agents?.some((a) => (a.id || a.agent_id) === cachedId)) {
    return cachedId;
  }

  console.log(chalk.gray('   (no cached browser agent for this workspace yet - creating one, one-time only)'));
  const identity = {
    name: 'AI Browser (CLI)',
    nickname: 'aivin-browser-cli',
    email: `aivin-browser-cli+${workspaceId}@local.invalid`,
  };

  // `/ai-staff/update` requires name/nickname/email again even though only `plugins` is actually
  // changing (confirmed while testing) - default to the NEW agent's own identity, but when falling
  // back to an EXISTING agent below, this must become THAT agent's real identity instead, or the
  // update call would silently overwrite/rename someone's real agent with the CLI's placeholder
  // name - a real, destructive bug caught in review before ever shipping.
  let agentId;
  let updateIdentity = identity;
  try {
    const created = await createAgent(serverUrl, authHeaders, {
      ...identity,
      bio: 'Auto-created by `aivin browser` - runs AI Browser missions triggered from the CLI.',
      workspaceId,
    });
    agentId = created.id || created.agent_id;
    await pullAgentIntoWorkspace(serverUrl, authHeaders, { agentId, workspaceId });
  } catch (error) {
    // Confirmed hitting this directly while testing: accounts on a plan with a low agent-count
    // limit get a clear "limit reached" error here. Rather than dead-ending, fall back to reusing
    // the workspace's own first existing agent (if any) - enabling official.ai_browser on it is a
    // much better outcome than making the user go figure out --agent <id> themselves after a
    // confusing failure.
    const existing = workspace.agents?.[0];
    if (!existing) throw error; // nothing to fall back to - surface the original error as-is
    const message = error.response?.data?.message || error.message;
    console.log(chalk.yellow(`   ⚠️  Couldn't create a dedicated agent (${message}) - reusing "${existing.nickname || existing.name}" instead.`));
    agentId = existing.id || existing.agent_id;
    updateIdentity = { name: existing.name, nickname: existing.nickname, email: existing.email };
  }

  // Merge, don't replace - an existing agent (the fallback path above) may already have OTHER
  // plugins enabled; sending plugin_ids: ['official.ai_browser'] alone would silently wipe those.
  const existingPluginIds = workspace.agents?.find((a) => (a.id || a.agent_id) === agentId)?.plugins?.plugin_ids || [];
  const mergedPluginIds = existingPluginIds.includes('official.ai_browser') ? existingPluginIds : [...existingPluginIds, 'official.ai_browser'];

  await axios
    .post(
      `${serverUrl}/ai-staff/update?workspace_id=${encodeURIComponent(workspaceId)}`,
      { id: agentId, ...updateIdentity, plugins: { plugin_ids: mergedPluginIds } },
      authHeaders,
    )
    .catch((error) => {
      const message = error.response?.data?.message || error.message;
      console.log(chalk.yellow(`   ⚠️  Could not enable official.ai_browser on the agent automatically: ${message}`));
    });

  cache[workspaceId] = agentId;
  saveBrowserCliAgentCache(cache);
  console.log(chalk.green(`   ✅ Agent ready for AI Browser CLI use (cached for next time).`));
  return agentId;
}

/** Chrome's own remote-debugging discovery endpoint - reachable only if the user already relaunched
 *  Chrome with `--remote-debugging-port`. Returns the CDP WebSocket URL for the whole browser, or
 *  null if nothing's listening there (or something else entirely is - see below). */
async function probeLocalChromeDebugger(port = CHROME_DEBUG_PORT) {
  try {
    const res = await axios.get(`http://127.0.0.1:${port}/json/version`, { timeout: 2000 });
    // Something answered - but NOT necessarily Chrome/Edge. Confirmed hitting this for real: this
    // port is also where this project's own local dev stack publishes a headless Lightpanda
    // container (no UI at all), which happily speaks CDP and would otherwise look identical to a
    // real browser here - "mission ran but no window ever appeared" was the resulting symptom.
    // Real Chrome/Edge both report a `Browser` field like "Chrome/123.0..." / "Edg/123.0...".
    const product = String(res.data?.Browser || '');
    if (!/^(Chrome|Edg)\//.test(product)) {
      return { wsUrl: null, conflict: product || 'unknown service', browserId: null };
    }
    const browserId = /^Edg\//.test(product) ? 'edge' : 'chrome';
    return { wsUrl: res.data?.webSocketDebuggerUrl || null, conflict: null, browserId };
  } catch {
    return { wsUrl: null, conflict: null, browserId: null };
  }
}

// Any Chromium-based browser works identically here (same --remote-debugging-port / CDP protocol).
// Order here is only a last-resort tiebreaker (see findLocalBrowser) - actual selection prefers the
// user's real OS default browser via detectDefaultBrowserId(), or an explicit --browser flag.
const LOCAL_BROWSERS = [
  {
    id: 'edge',
    name: 'Microsoft Edge',
    win32: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
    darwin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    linux: 'microsoft-edge',
    profileDirWin32: ['AppData', 'Local', 'Microsoft', 'Edge', 'User Data'],
    profileDirDarwin: ['Library', 'Application Support', 'Microsoft Edge'],
    profileDirLinux: ['.config', 'microsoft-edge'],
  },
  {
    id: 'chrome',
    name: 'Google Chrome',
    win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: 'google-chrome',
    profileDirWin32: ['AppData', 'Local', 'Google', 'Chrome', 'User Data'],
    profileDirDarwin: ['Library', 'Application Support', 'Google', 'Chrome'],
    profileDirLinux: ['.config', 'google-chrome'],
  },
];

function resolveBrowserInstall(browser) {
  const home = os.homedir();
  let exe = null;
  let profileSegments;
  if (process.platform === 'win32') {
    exe = browser.win32.find((p) => fs.existsSync(p)) || null;
    profileSegments = browser.profileDirWin32;
  } else if (process.platform === 'darwin') {
    exe = fs.existsSync(browser.darwin) ? browser.darwin : null;
    profileSegments = browser.profileDirDarwin;
  } else {
    exe = browser.linux; // assumed on PATH on Linux - no reliable single default install path there
    profileSegments = browser.profileDirLinux;
  }
  if (!exe) return null;
  return { id: browser.id, name: browser.name, exe, profileDir: path.join(home, ...profileSegments) };
}

/** Best-effort read of the OS's actual "default browser" setting, mapped to one of LOCAL_BROWSERS'
 *  `id`s - or null if it can't be determined (unsupported platform, unknown browser, command
 *  missing/failed) or if the default is a non-Chromium browser (Firefox/Safari - no CDP support, so
 *  there's nothing to tunnel into). Never throws - this is a "nice to have" signal, `findLocalBrowser`
 *  falls back to install-order when it's unavailable. */
function detectDefaultBrowserId() {
  try {
    if (process.platform === 'win32') {
      // The per-user UserChoice hash-protected key (what Settings > Default apps itself writes) is
      // awkward to read reliably across Windows versions and, confirmed while testing this, is often
      // just absent (no explicit override ever made). `Software\Classes\http\shell\open\command` is
      // what Windows actually resolves to at launch time regardless of how it got set - HKCU holds a
      // per-user override if one exists, HKLM is the system-wide fallback otherwise. Reading the
      // command line's exe name directly sidesteps needing to decode a ProgId at all.
      const readCommand = (hive) => {
        try {
          return execSync(`reg query "${hive}\\Software\\Classes\\http\\shell\\open\\command"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {
          return '';
        }
      };
      const out = readCommand('HKCU') || readCommand('HKLM');
      if (/msedge\.exe/i.test(out)) return 'edge';
      if (/chrome\.exe/i.test(out)) return 'chrome';
      return null; // Firefox, or something unrecognized
    }
    if (process.platform === 'darwin') {
      // No single stock CLI for this on macOS - LaunchServices' own plist is the source of truth
      // Settings > Desktop & Dock reads from, `plutil` (stock, ships with macOS) can dump it as JSON.
      const plistPath = path.join(
        os.homedir(), 'Library', 'Preferences', 'com.apple.LaunchServices',
        'com.apple.launchservices.secure.plist',
      );
      if (!fs.existsSync(plistPath)) return null;
      const json = execSync(`plutil -convert json -o - "${plistPath}"`, { encoding: 'utf8' });
      const handlers = JSON.parse(json)?.LSHandlers || [];
      const httpHandler = handlers.find((h) => h.LSHandlerURLScheme === 'http');
      const bundleId = String(httpHandler?.LSHandlerRoleAll || '').toLowerCase();
      if (bundleId.includes('edge')) return 'edge';
      if (bundleId.includes('chrome')) return 'chrome';
      return null; // Safari, Firefox, or undetermined
    }
    // Linux: xdg-settings is the freedesktop.org standard way, present on most desktop distros.
    const out = execSync('xdg-settings get default-web-browser', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (/edge/i.test(out)) return 'edge';
    if (/chrome/i.test(out)) return 'chrome';
    return null;
  } catch {
    return null; // command missing, key absent, parse failure - all fine to just not know
  }
}

/**
 * Picks which installed browser to drive, in priority order:
 *  1. `preferredId` (from `--browser edge|chrome`) - explicit always wins, errors clearly if that
 *     browser isn't actually installed rather than silently falling through to another one.
 *  2. The OS's actual default browser, IF it's Chromium-based and installed - this is what makes
 *     "drives your own logged-in browser" true; guessing wrong here would tunnel into a browser
 *     profile the user doesn't actually use, with none of the cookies/logins they expect.
 *  3. Whatever's installed from LOCAL_BROWSERS, in list order - last resort when the real default
 *     couldn't be determined or isn't Chromium (Firefox/Safari have no CDP to tunnel into).
 * Always logs which one it picked and why when there was more than one candidate, so step 3 in
 * particular is never a silent surprise.
 */
function findLocalBrowser(preferredId) {
  const installed = LOCAL_BROWSERS.map(resolveBrowserInstall).filter(Boolean);
  if (installed.length === 0) return null;

  if (preferredId) {
    const match = installed.find((b) => b.id === preferredId);
    if (match) return match;
    throw new Error(`--browser ${preferredId} was requested, but it isn't installed at any of the usual locations. Installed: ${installed.map((b) => b.id).join(', ') || 'none'}.`);
  }

  if (installed.length > 1) {
    const defaultId = detectDefaultBrowserId();
    const byDefault = defaultId && installed.find((b) => b.id === defaultId);
    if (byDefault) return byDefault;
    console.log(chalk.gray(
      `   (multiple browsers installed (${installed.map((b) => b.name).join(', ')}) and couldn't confirm your OS default - ` +
      `using ${installed[0].name}. Pass --browser ${installed.map((b) => b.id).join('|')} to pick.)`,
    ));
  }

  return installed[0];
}

function launchCommandHint(browser, port = CHROME_DEBUG_PORT) {
  const label = browser ? browser.name : 'Chrome or Edge';
  const exe = browser ? `"${browser.exe}"` : '<your browser>';
  if (process.platform === 'win32') return `& ${exe} --remote-debugging-port=${port}  (${label})`;
  if (process.platform === 'darwin') return `open -a "${label}" --args --remote-debugging-port=${port}`;
  return `${browser ? browser.exe : 'google-chrome'} --remote-debugging-port=${port}`;
}

function printChromeLaunchHelp(port = CHROME_DEBUG_PORT, preferredId) {
  const browser = findLocalBrowser(preferredId);
  console.log(chalk.yellow('\n⚠️  Could not start a local browser for AI Browser.'));
  console.log(`   ${chalk.cyan(launchCommandHint(browser, port))}\n`);
  console.log(chalk.gray('   ...or pass --remote for a server-side browser instead (no local browser needed).'));
}

/** Launches a browser window dedicated to `aivin browser`, on ITS OWN profile
 *  (AIVIN_BROWSER_PROFILE_DIR) - never the user's real daily-driver one. This is what makes local
 *  mode zero-friction after the first run: because it's a separate profile, it never collides with
 *  whatever the user's main browser is already doing (no "close all your windows first"), and once
 *  running it just stays up - a later mission finds it already listening and reuses it, opening a
 *  new tab in the SAME window rather than launching anything again. The one real cost: the first
 *  time any given site is used (Facebook, etc.), the user logs in once here, same as any fresh
 *  profile - after that it persists exactly like their main browser's cookies do. */
async function launchLocalChromeWithDebugging(port = CHROME_DEBUG_PORT, preferredId) {
  const browser = findLocalBrowser(preferredId);
  if (!browser) {
    throw new Error(`Could not find a local Chrome/Edge install automatically - relaunch one manually with: ${launchCommandHint(null, port)}`);
  }
  const firstRun = !fs.existsSync(AIVIN_BROWSER_PROFILE_DIR);
  fs.mkdirSync(AIVIN_BROWSER_PROFILE_DIR, { recursive: true });
  // No pre-flight SingletonLock check here on purpose (an earlier version of this had one, copied
  // from the old "don't touch the user's real profile" logic where it made sense): by the time we
  // get here, probeLocalChromeDebugger() has ALREADY confirmed nothing is answering on `port`, so a
  // present lock file can only be stale (left behind by an unclean shutdown/crash) - Chromium itself
  // already detects and clears stale locks on startup (checks whether the owning PID is still
  // alive), more reliably than re-implementing that check here. A pre-check could only ever produce
  // a false positive: a confusing "already open, go close it" error pointing at a window that isn't
  // actually running anywhere.
  if (firstRun) {
    console.log(chalk.gray(`   First run: opening a NEW, separate ${browser.name} window just for AI Browser (your regular ${browser.name} is untouched).`));
    console.log(chalk.gray(`   You'll need to log into any site the mission needs (Facebook, etc.) once in THIS window - it'll stay logged in from then on.`));
  } else {
    console.log(chalk.gray(`   Opening your dedicated AI Browser window...`));
  }
  const child = spawn(browser.exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${AIVIN_BROWSER_PROFILE_DIR}`, '--no-first-run', '--start-maximized'], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { wsUrl, conflict } = await probeLocalChromeDebugger(port);
    if (wsUrl) return wsUrl;
    if (conflict) {
      throw new Error(
        `Port ${port} is already in use by something else (reported itself as "${conflict}", not Chrome/Edge) - ` +
        `${browser.name} can't bind its debug port there. Free that port, or rerun with --debug-port <other-port>.`,
      );
    }
  }
  throw new Error(`${browser.name} launched but its debug port never came up in time.`);
}

/**
 * Opens 2 raw WebSocket connections - one to the backend's relay (authenticated by API key), one
 * to the user's own local Chrome's real CDP endpoint - and pipes frames both directions verbatim.
 * `close()` disconnects both sides; the user's actual browser window is never touched beyond this
 * one CDP connection, closing the tunnel just detaches Puppeteer server-side.
 */
function openLocalTunnel(serverUrl, apiKey, chromeWsUrl) {
  const tunnelId = randomUUID();
  const relayUrl = `${serverUrl.replace(/^http/, 'ws')}/browser-tunnel/external?tunnel_id=${tunnelId}`;

  // API key goes in a header, NOT a `?token=` query param - WS upgrade URLs are exactly the kind
  // of thing that ends up verbatim in reverse-proxy/CDN/access logs, unlike headers.
  const toBackend = new WSClient(relayUrl, { headers: { Authorization: `Bearer ${apiKey || ''}` } });
  const toChrome = new WSClient(chromeWsUrl);

  const relay = (from, to) => {
    from.on('message', (data, isBinary) => {
      if (to.readyState === WSClient.OPEN) to.send(data, { binary: isBinary });
    });
    from.on('close', () => {
      if (to.readyState === WSClient.OPEN) to.close();
    });
    from.on('error', () => {
      if (to.readyState === WSClient.OPEN) to.close();
    });
  };
  relay(toBackend, toChrome);
  relay(toChrome, toBackend);

  const ready = Promise.all([
    new Promise((resolve, reject) => {
      toBackend.once('open', resolve);
      toBackend.once('error', reject);
    }),
    new Promise((resolve, reject) => {
      toChrome.once('open', resolve);
      toChrome.once('error', reject);
    }),
  ]);

  const close = () => {
    try { toBackend.close(); } catch { /* already closed */ }
    try { toChrome.close(); } catch { /* already closed */ }
  };

  return { tunnelId, ready, close };
}

async function runBrowserMissionLocal(mission, options) {
  const serverUrl = missionServerUrl();
  const apiKey = process.env.API_KEY;
  const authHeaders = missionAuthHeaders();
  const tenantClient = parseApiKeyClient(apiKey || '') || 'unknown';

  const preferredId = options.browser ? String(options.browser).toLowerCase() : undefined;
  if (preferredId && preferredId !== 'edge' && preferredId !== 'chrome') {
    throw new Error(`--browser must be "edge" or "chrome", got "${options.browser}".`);
  }

  // --debug-port pins an exact port (strict - errors immediately if it's taken by something else).
  // Without it, try the conventional 9222 first, then a few neighbors - confirmed needed for real:
  // this project's OWN local dev stack publishes an unrelated container on 9222 (see
  // probeLocalChromeDebugger's comment), so erroring out on the very first conflict there would make
  // `aivin browser` unusable out of the box for anyone running that stack, every single time.
  const explicitPort = options.debugPort !== undefined;
  const candidatePorts = explicitPort ? [Number(options.debugPort)] : [CHROME_DEBUG_PORT, 9223, 9224, 9225];

  let debugPort;
  let chromeWsUrl;
  const triedConflicts = [];
  for (const port of candidatePorts) {
    const probed = await probeLocalChromeDebugger(port);
    if (probed.wsUrl && preferredId && probed.browserId !== preferredId) {
      // Something's already listening, but it's the OTHER browser than what --browser asked for -
      // using it silently would drive the wrong profile (wrong cookies/logins), so this has to be a
      // hard error rather than a best-effort fallback, even mid auto-retry.
      throw new Error(
        `--browser ${preferredId} was requested, but the browser already listening on port ${port} is ${probed.browserId} instead. ` +
        `Close it and relaunch ${preferredId} with --remote-debugging-port=${port}, or use --debug-port to point at a different port.`,
      );
    }
    if (probed.wsUrl) { debugPort = port; chromeWsUrl = probed.wsUrl; break; }
    if (probed.conflict) { triedConflicts.push(`${port} (${probed.conflict})`); continue; }
    debugPort = port; // free port, nothing answering at all - safe to launch here
    break;
  }
  if (debugPort === undefined) {
    throw new Error(
      `${explicitPort ? 'Requested' : 'All of the usual'} debug port${candidatePorts.length > 1 ? 's are' : ' is'} already in use by something else, not Chrome/Edge: ${triedConflicts.join(', ')}. ` +
      `Free one of them, or pass --debug-port <port> to use a specific one.`,
    );
  }

  if (!chromeWsUrl) {
    // Safe to always auto-launch now (unlike an earlier version of this): this opens AIVIN_BROWSER_
    // PROFILE_DIR, a profile dedicated to `aivin browser` that's never the user's real daily-driver
    // browser, so there's no risk of colliding with (or having to close) whatever they're already
    // running elsewhere.
    try {
      chromeWsUrl = await launchLocalChromeWithDebugging(debugPort, preferredId);
    } catch (error) {
      printChromeLaunchHelp(debugPort, preferredId);
      throw error;
    }
  }

  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  const agentId = options.agent || (await resolveOrCreateBrowserAgent(serverUrl, authHeaders, workspace));

  console.log(chalk.blue('🌐 AI Browser (local - your own browser):'), mission);
  console.log(chalk.gray(`   Workspace: ${workspace.name || workspace.id}`));

  const tunnel = openLocalTunnel(serverUrl, apiKey, chromeWsUrl);
  try {
    await tunnel.ready;
  } catch (error) {
    tunnel.close();
    throw new Error(`Could not open the local browser tunnel: ${error.message}`, { cause: error });
  }

  const sessionId = `browser-cli-${randomUUID()}`;
  console.log(chalk.gray(`   Session: ${sessionId}`));

  // Ctrl+C: request cooperative cancellation (same mechanism sdk.browser.cancel() uses - checked
  // between agentic-loop steps, can't interrupt a step already in flight) AND close the tunnel.
  // Closing the tunnel alone isn't enough to stop a mission stuck in an LLM call that hasn't
  // touched the browser connection yet (confirmed while testing this) - the cancel request is what
  // actually gets it to stop at its next chance to check. The tab this mission was using stays open
  // either way - never force-closed, since local mode is explicitly "your own browser, your tabs".
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) return;
    interrupted = true;
    console.log(chalk.yellow('\n\n⏹  Stopping... (requesting cancellation - may take a moment, one agentic step at a time)'));
    requestBrowserCancel(serverUrl, authHeaders).catch(() => {});
    tunnel.close();
    console.log(chalk.gray('   The tab this mission was using is still open in your browser - close it yourself if you don\'t need it.'));
  };
  process.on('SIGINT', onSigint);

  // Fired concurrently, not sequentially - execute-interactive is a SYNCHRONOUS call (blocks until
  // the mission ends), so the log watcher has to already be listening before/as it fires, not after.
  const missionPromise = axios.post(
    // `/plugins/` prefix: OfficialPluginModules.ts registers every official plugin module (incl.
    // AIBrowserModule) via RouterModule.register({ path: 'plugins', ... }) - easy to miss, confirmed
    // by testing directly against the API (plain /ai-browser/... 404s, /plugins/ai-browser/... works).
    `${serverUrl}/plugins/ai-browser/execute-interactive`,
    {
      mission,
      workspace_id: workspace.id || workspace._id,
      agent_id: agentId,
      session_id: sessionId,
      data: { __local_tunnel_id: tunnel.tunnelId, start_url: options.url || guessStartUrl(mission) },
    },
    authHeaders,
  );
  const watchPromise = options.watch !== false
    ? streamBrowserMissionLog(serverUrl, apiKey, sessionId, tenantClient, { openViewerOnHIL: false })
    : Promise.resolve();

  try {
    // execute-interactive responds immediately (fire-and-forget - see AIBrowserController.ts's
    // comment on why: a synchronous wait here would hit the same Cloudflare 524 the gRPC
    // browser.run() call did). The REAL outcome is whatever the log stream above already printed
    // (ai_browser.success/failed) - this Promise.all is just making sure both sides are done.
    await Promise.all([missionPromise, watchPromise]);
  } catch (error) {
    if (!interrupted) {
      const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
      throw new Error(`AI Browser mission failed to start: ${message}`, { cause: error });
    }
  } finally {
    process.off('SIGINT', onSigint);
    tunnel.close();
  }

  if (!interrupted) {
    console.log(chalk.gray('\n   Done - see the log lines above for the outcome, and your own browser for the result.'));
  }
}

/** REST twin of `sdk.browser.cancel()` - the CLI has no gRPC client, only axios. See
 *  AIBrowserController.cancel's comment for the exact semantics (cooperative, own-tenant-only). */
async function requestBrowserCancel(serverUrl, authHeaders) {
  await axios.post(`${serverUrl}/plugins/ai-browser/cancel`, {}, authHeaders);
}

async function runBrowserMissionRemote(mission, options) {
  const serverUrl = missionServerUrl();
  const apiKey = process.env.API_KEY;
  const authHeaders = missionAuthHeaders();
  const tenantClient = parseApiKeyClient(apiKey || '') || 'unknown';

  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  // Same interactive resolver `aivin do` uses (not the throw-if-missing resolveAgentId) - a fresh
  // workspace commonly has zero agents installed yet, and this offers to search/install/create one
  // instead of just failing. AI Browser itself is always used as the TOOL; the agent is only the
  // identity/session context the mission (and HIL suspend/resume) runs under.
  const agent = await resolveAgentInteractive(serverUrl, authHeaders, workspace, options.agent);
  const agentId = agent.id || agent.agent_id;

  console.log(chalk.blue('🌐 AI Browser (remote - server-side browser):'), mission);
  console.log(chalk.gray(`   Workspace: ${workspace.name || workspace.id}   Agent: ${agent.nickname || agent.name || agentId}`));

  let response;
  try {
    response = await axios.post(
      `${serverUrl}/agent/start-work`,
      {
        prompt: BROWSER_MISSION_PREFIX + mission,
        mission: BROWSER_MISSION_PREFIX + mission,
        workspace_id: workspace.id || workspace._id,
        agent_id: agentId,
        project_id: options.project,
      },
      authHeaders,
    );
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to start AI Browser mission: ${message}`, { cause: error });
  }

  const result = response.data ?? {};
  if (result.success === false) {
    throw new Error(result.message || 'Failed to start AI Browser mission');
  }
  const threadId = result.data?.thread_id;
  console.log(chalk.gray(`   Thread: ${threadId || 'unknown'}`));

  if (options.watch !== false && threadId) {
    await streamBrowserMissionLog(serverUrl, apiKey, threadId, tenantClient);
  }
}

async function runBrowserMission(mission, options) {
  const serverUrl = missionServerUrl();
  const apiKey = process.env.API_KEY;
  const tenantClient = parseApiKeyClient(apiKey || '') || 'unknown';

  // --view alone (no mission) - just open the viewer for whatever HIL session is already active,
  // without starting a new mission. Useful if the auto-open above was missed/closed by accident.
  // Same for both modes - the viewer just reacts to whatever browser:cast-start fires next.
  if (options.view) {
    await openBrowserViewer(serverUrl, apiKey, tenantClient);
    return;
  }

  if (options.remote) {
    await runBrowserMissionRemote(mission, options);
  } else {
    await runBrowserMissionLocal(mission, options);
  }
}

async function runMission(agentNickname, mission, options) {
  const serverUrl = missionServerUrl();
  const apiKey = process.env.API_KEY;
  const authHeaders = missionAuthHeaders();

  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  const agent = await resolveAgentInteractive(serverUrl, authHeaders, workspace, agentNickname);
  const agentId = agent.id || agent.agent_id;

  console.log(chalk.blue('🚀 Doing:'), mission);
  console.log(chalk.gray(`   Workspace: ${workspace.name || workspace.id}   Agent: ${agent.nickname || agent.name || agentId}`));

  let response;
  try {
    response = await axios.post(
      `${serverUrl}/agent/start-work`,
      {
        prompt: mission,
        mission,
        workspace_id: workspace.id || workspace._id,
        agent_id: agentId,
        project_id: options.project,
      },
      authHeaders,
    );
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to start mission: ${message}`, { cause: error });
  }

  const result = response.data ?? {};
  if (result.success === false) {
    throw new Error(result.message || 'Failed to start mission');
  }
  const threadId = result.data?.thread_id;
  console.log(chalk.gray(`   Thread: ${threadId || 'unknown'}`));

  if (options.watch !== false && threadId) {
    await streamMissionLog(serverUrl, apiKey, threadId);
  }
}

async function createAutomationJob(description, options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();

  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  const agentId = resolveAgentId(workspace, options.agent);

  console.log(chalk.blue('🔄 Creating automation job...'));
  console.log(chalk.gray(`   Workspace: ${workspace.name || workspace.id}`));

  let response;
  try {
    response = await axios.post(
      `${serverUrl}/automation/jobs/create`,
      {
        mission: description.length > 60 ? `${description.slice(0, 57)}...` : description,
        prompt: description,
        agent_id: agentId,
        workspace_id: workspace.id || workspace._id,
        project_id: options.project,
        schedule_condition: options.schedule,
      },
      authHeaders,
    );
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to create automation job: ${message}`, { cause: error });
  }

  const job = response.data ?? {};
  console.log(chalk.green('✅ Automation job created!'));
  console.log(chalk.gray(`   ID: ${job.id}`));
  console.log(chalk.gray(`   Mission: ${job.mission}`));
  if (job.schedule_condition) console.log(chalk.gray(`   Schedule: ${job.schedule_condition}`));
  if (job.next_run) console.log(chalk.gray(`   Next run: ${job.next_run}`));
}

/**
 * A workspace's `projects` array has no guaranteed "default" entry the way `agents`/Personal do -
 * just take the first one when --project is omitted, and say so explicitly if there isn't one
 * (list/mine are scoped by project on the backend, unlike create/get/update/delete which take a
 * bare task id or no project at all).
 */
function resolveProjectId(workspace, explicitProjectId) {
  if (explicitProjectId) return explicitProjectId;
  const projectId = workspace.projects?.[0]?.id;
  if (!projectId) {
    throw new Error(
      `Workspace "${workspace.name || workspace.id}" has no projects - pass --project <id> (see \`aivin workspace\`).`,
    );
  }
  return projectId;
}

async function listTasks(options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();

  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  const projectId = resolveProjectId(workspace, options.project);

  const params = {};
  if (options.status) params.status = options.status;
  if (options.assignee) params.assign_id = options.assignee;
  if (options.search) params.search = options.search;

  let response;
  try {
    response = await axios.get(`${serverUrl}/task/${projectId}/list`, { ...authHeaders, params });
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to list tasks: ${message}`, { cause: error });
  }

  const tasks = Array.isArray(response.data) ? response.data : response.data?.items || [];
  if (tasks.length === 0) {
    console.log(chalk.yellow('No tasks found.'));
    return;
  }
  console.log(chalk.blue(`${tasks.length} task(s) in project ${projectId}:\n`));
  tasks.forEach((t) => {
    console.log(`${chalk.bold(t.title || t.id)}  ${chalk.gray(`(${t.id})`)}`);
    console.log(
      chalk.gray(
        `   status: ${t.status}${t.priority ? `  priority: ${t.priority}` : ''}${t.assign_id ? `  assignee: ${t.assign_id}` : ''}`,
      ),
    );
  });
}

async function listMyTasks(options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();

  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  const projectId = resolveProjectId(workspace, options.project);

  let response;
  try {
    response = await axios.get(`${serverUrl}/task/${projectId}/my-task`, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to list your tasks: ${message}`, { cause: error });
  }

  const tasks = Array.isArray(response.data) ? response.data : response.data?.items || [];
  if (tasks.length === 0) {
    console.log(chalk.yellow('No tasks assigned to you in this project.'));
    return;
  }
  console.log(chalk.blue(`${tasks.length} task(s) assigned to you:\n`));
  tasks.forEach((t) => {
    console.log(`${chalk.bold(t.title || t.id)}  ${chalk.gray(`(${t.id})`)}  ${chalk.gray(t.status)}`);
  });
}

async function getTaskById(id) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();

  let response;
  try {
    response = await axios.get(`${serverUrl}/task/${id}`, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to get task: ${message}`, { cause: error });
  }

  console.log(JSON.stringify(response.data ?? {}, null, 2));
}

async function updateTaskById(id, options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();

  const data = {};
  if (options.status) data.status = options.status;
  if (options.title) data.title = options.title;
  if (options.description) data.description = options.description;
  if (options.assignee) data.assign_id = options.assignee;
  if (options.priority) data.priority = options.priority;
  if (Object.keys(data).length === 0) {
    throw new Error('Nothing to update - pass at least one of --status/--title/--description/--assignee/--priority.');
  }

  let response;
  try {
    response = await axios.post(`${serverUrl}/task/${id}/update`, data, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to update task: ${message}`, { cause: error });
  }

  const task = response.data ?? {};
  console.log(chalk.green('✅ Task updated!'));
  console.log(chalk.gray(`   Status: ${task.status}`));
}

async function deleteTaskById(id) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();

  try {
    await axios.delete(`${serverUrl}/task/${id}/delete`, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to delete task: ${message}`, { cause: error });
  }

  console.log(chalk.green(`✅ Task ${id} deleted.`));
}

async function createTask(description, options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();

  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);

  console.log(chalk.blue('📋 Creating task...'));
  console.log(chalk.gray(`   Workspace: ${workspace.name || workspace.id}`));

  let response;
  try {
    response = await axios.post(
      `${serverUrl}/task/create`,
      {
        title: description.length > 80 ? `${description.slice(0, 77)}...` : description,
        content: description,
        workspace_id: workspace.id || workspace._id,
        project_id: options.project,
        assign_id: options.assignee,
      },
      authHeaders,
    );
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to create task: ${message}`, { cause: error });
  }

  const task = response.data ?? {};
  console.log(chalk.green('✅ Task created!'));
  console.log(chalk.gray(`   ID: ${task.id}`));
  console.log(chalk.gray(`   Title: ${task.title}`));
  console.log(chalk.gray(`   Status: ${task.status}`));
}

/**
 * `aivin workspace` - interactive workspace + project picker (arrow-key inquirer prompts, matching
 * `aivin create`'s existing interactive style) so a user can find a workspace/project id to pass
 * as --workspace/--project to `aivin do`/`do job`/`task`, without memorizing them upfront.
 */
async function pickWorkspaceAndProject(options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();
  const workspaces = await listWorkspaces(serverUrl, authHeaders);

  if (workspaces.length === 0) {
    console.log(chalk.yellow('No workspace found for this account.'));
    return;
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY || options.plain) {
    for (const ws of workspaces) {
      console.log(chalk.bold(ws.name || ws.id) + chalk.gray(`  (${ws.id})${ws.name === 'Personal' ? '  [personal]' : ''}`));
      (ws.projects || []).forEach((p) => console.log(chalk.gray(`    - ${p.name || p.id}  (${p.id})`)));
    }
    return;
  }

  const { workspaceId } = await inquirer.prompt([
    {
      type: 'select',
      name: 'workspaceId',
      message: 'Select a workspace:',
      choices: workspaces.map((ws) => ({
        name: `${ws.name || ws.id}${ws.name === 'Personal' ? chalk.gray('  (personal)') : ''}`,
        value: ws.id || ws._id,
      })),
    },
  ]);
  const workspace = workspaces.find((ws) => (ws.id || ws._id) === workspaceId);

  let projectId;
  if (workspace.projects?.length > 0) {
    const { pickedProjectId } = await inquirer.prompt([
      {
        type: 'select',
        name: 'pickedProjectId',
        message: 'Select a project:',
        choices: [
          { name: chalk.gray('(none - workspace level)'), value: null },
          ...workspace.projects.map((p) => ({ name: p.name || p.id, value: p.id })),
        ],
      },
    ]);
    projectId = pickedProjectId;
  } else {
    console.log(chalk.gray(`\n"${workspace.name || workspace.id}" has no projects yet - staying at workspace level (no --project needed).`));
  }

  console.log(chalk.green('\n✅ Selected:'));
  console.log(`   ${chalk.gray('Workspace:')} ${chalk.bold(workspace.name || 'unnamed')}`);
  if (projectId) {
    const project = workspace.projects.find((p) => p.id === projectId);
    console.log(`   ${chalk.gray('Project:')}   ${chalk.bold(project?.name || 'unnamed')}`);
  }
  console.log(chalk.gray('\nUse with `aivin do`/`aivin do job`/`aivin task`:'));
  console.log(`   --workspace ${workspace.id || workspace._id}${projectId ? ` --project ${projectId}` : ''}`);
}

// ── Projects within a workspace - create/update/delete ─────────────────────────────────────────
//
// `POST /project/:workspaceId/project/edit` is a real upsert on the backend: omit `id` to create a
// new project, include it to update the matching one - there's no separate create endpoint.

async function upsertProject(serverUrl, authHeaders, { workspaceId, id, name }) {
  let response;
  try {
    response = await axios.post(`${serverUrl}/project/${workspaceId}/project/edit`, { id, name }, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to save project: ${message}`, { cause: error });
  }
  return response.data ?? {};
}

async function deleteProjectById(serverUrl, authHeaders, { workspaceId, projectId }) {
  try {
    await axios.delete(`${serverUrl}/project/${workspaceId}/project/${projectId}/delete`, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message || error.code || 'Unknown error';
    throw new Error(`Failed to delete project: ${message}`, { cause: error });
  }
}

async function createProjectCmd(name, options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();
  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  const project = await upsertProject(serverUrl, authHeaders, { workspaceId: workspace.id || workspace._id, name });
  console.log(chalk.green('✅ Project created!'));
  console.log(chalk.gray(`   Workspace: ${workspace.name || workspace.id}`));
  console.log(chalk.gray(`   Name: ${project.name || name}`));
  if (project.id) console.log(chalk.gray(`   ID: ${project.id}`));
}

async function updateProjectCmd(projectId, options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();
  if (!options.name) {
    throw new Error('Nothing to update - pass --name <new name>.');
  }
  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  await upsertProject(serverUrl, authHeaders, { workspaceId: workspace.id || workspace._id, id: projectId, name: options.name });
  console.log(chalk.green(`✅ Project ${projectId} updated.`));
}

async function deleteProjectCmd(projectId, options) {
  const serverUrl = missionServerUrl();
  const authHeaders = missionAuthHeaders();
  const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
  await deleteProjectById(serverUrl, authHeaders, { workspaceId: workspace.id || workspace._id, projectId });
  console.log(chalk.green(`✅ Project ${projectId} deleted.`));
}

program
  .command('browser [mission]')
  .description("Run an AI Browser mission - by default opens/reuses a local browser window dedicated to AI Browser (own profile, own cookies - log in once, watch missions run live from then on); --remote uses a server-side browser instead")
  .option('--remote', 'Use a server-side pooled browser instead of your own local one (no local browser needed, no cookies/logins carried over)')
  .option('--debug-port <port>', 'Local mode only: port to look for/launch your browser\'s remote debugging on (default: 9222, auto-tries a few nearby ports if that one is taken by something else) - pass this to pin an exact port instead')
  .option('--browser <edge|chrome>', "Local mode only: which browser to drive - default: auto-detects your OS's actual default browser, falling back to whichever of Edge/Chrome is installed if that can't be determined")
  .option('--url <url>', "Local mode only: open this URL before the mission starts, instead of a blank page - skips a wasted first analysis step and avoids the AI having to search the web to find the target site itself (auto-guessed for a few well-known sites mentioned by name in the mission if omitted)")
  .option('--workspace <id>', 'Workspace id to run in (default: your personal workspace)')
  .option('--project <id>', 'Project id within the workspace (--remote only)')
  .option('--agent <id>', "Agent id to run as (default: an auto-created/cached agent for local mode, or the workspace's default agent for --remote) - AI Browser is triggered as a tool this agent uses, real HIL suspend/resume requires an agent context")
  .option('--no-watch', 'Fire the mission and return immediately - skip streaming live progress and auto-opening the viewer')
  .option('--view', 'Just (re)open the fullscreen interactive viewer for whatever HIL session is already active - no mission is started')
  .action(async (mission, options) => {
    try {
      if (!options.view) {
        mission = await requireArg(mission, {
          prompt: 'What should the AI Browser do?',
          usage: 'Usage: aivin browser "<mission detail>"  (or: aivin browser --view to just reopen the interactive viewer)',
        });
      }
      await runBrowserMission(mission, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

const doCommand = program
  .command('do [agentNickname] [mission]')
  .description("Have <agentNickname> work toward a goal in the background - not a specific deployed plugin")
  .option('--workspace <id>', 'Workspace id to run in (default: your personal workspace)')
  .option('--project <id>', 'Project id within the workspace')
  .option('--no-watch', 'Fire the mission and return immediately - skip streaming live progress')
  .action(async (agentNickname, mission, options) => {
    try {
      mission = await requireArg(mission, {
        prompt: 'What should the agent do?',
        usage: 'Usage: aivin do <agent_nickname> "<mission detail>"  (or: aivin do job "<automation job description>")',
      });
      await runMission(agentNickname, mission, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

doCommand
  .command('job [description]')
  .description('Create a new automation job from a plain-language description')
  .option('--workspace <id>', 'Workspace id to create the job in (default: your personal workspace)')
  .option('--project <id>', 'Project id within the workspace')
  .option('--agent <id>', "Agent id the job runs as (default: the workspace's default agent)")
  .option('--schedule <condition>', 'Natural-language schedule, e.g. "every Monday at 9am" (default: let the platform infer one)')
  .action(async (description, options) => {
    try {
      description = await requireArg(description, { prompt: 'What should this automation job do?', usage: 'Usage: aivin do job "<automation job description>"' });
      await createAutomationJob(description, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

const taskCommand = program
  .command('task [description]')
  .description('Create a new task from a plain-language description')
  .option('--workspace <id>', 'Workspace id to create the task in (default: your personal workspace)')
  .option('--project <id>', 'Project id within the workspace')
  .option('--assignee <userId>', 'User id to assign the task to (default: unassigned)')
  .action(async (description, options) => {
    try {
      description = await requireArg(description, {
        prompt: 'What is this task?',
        usage: 'Usage: aivin task "<description>"  (or: aivin task list/mine/get/update/delete)',
      });
      await createTask(description, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

taskCommand
  .command('list')
  .description('List tasks in a project')
  .option('--workspace <id>', 'Workspace id (default: your personal workspace)')
  .option('--project <id>', "Project id (default: the workspace's first project)")
  .option('--status <status>', 'Filter by status (todo/doing/done/backlog/cancel)')
  .option('--assignee <userId>', 'Filter by assignee user id')
  .option('--search <text>', 'Filter by search text')
  .action(async (options) => {
    try {
      await listTasks(options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

taskCommand
  .command('mine')
  .description('List tasks assigned to you in a project')
  .option('--workspace <id>', 'Workspace id (default: your personal workspace)')
  .option('--project <id>', "Project id (default: the workspace's first project)")
  .action(async (options) => {
    try {
      await listMyTasks(options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

taskCommand
  .command('get [id]')
  .description('Get a task by id')
  .action(async (id) => {
    try {
      id = await requireArg(id, { prompt: 'Task id:', usage: 'Usage: aivin task get <id>' });
      await getTaskById(id);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

taskCommand
  .command('update [id]')
  .description('Update a task')
  .option('--status <status>', 'todo|doing|done|backlog|cancel')
  .option('--title <title>', 'New title')
  .option('--description <text>', 'New content/description')
  .option('--assignee <userId>', 'Reassign to this user id')
  .option('--priority <priority>', 'low|medium|high|urgent')
  .action(async (id, options) => {
    try {
      id = await requireArg(id, { prompt: 'Task id:', usage: 'Usage: aivin task update <id>' });
      await updateTaskById(id, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

taskCommand
  .command('delete [id]')
  .description('Delete a task')
  .action(async (id) => {
    try {
      id = await requireArg(id, { prompt: 'Task id to delete:', usage: 'Usage: aivin task delete <id>' });
      await deleteTaskById(id);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

program
  .command('workspace')
  .description('Browse your workspaces and projects, and pick one to use with --workspace/--project')
  .option('--plain', 'Print a flat list instead of the interactive picker (for scripts/CI)')
  .action(async (options) => {
    try {
      await pickWorkspaceAndProject(options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

const agentCommand = program.command('agent').description('Search, install, create, and publish AI Staff agents');

agentCommand
  .command('search [query]')
  .description('Search the AI Staff marketplace for an agent')
  .option('--workspace <id>', 'Workspace id for context (default: your personal workspace)')
  .option('--limit <n>', 'Max results to show')
  .action(async (query, options) => {
    try {
      query = await requireArg(query, { prompt: 'What are you looking for?', usage: 'Usage: aivin agent search "<query>"' });
      const serverUrl = missionServerUrl();
      const authHeaders = missionAuthHeaders();
      const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
      const results = await searchAgents(serverUrl, authHeaders, {
        query,
        workspaceId: workspace.id || workspace._id,
        limit: options.limit,
      });
      if (results.length === 0) {
        console.log(chalk.yellow(`No agents found matching "${query}".`));
        return;
      }
      console.log(chalk.blue(`Found ${results.length} agent(s) matching "${query}":\n`));
      results.forEach((a) => {
        console.log(chalk.bold(a.nickname || a.name) + chalk.gray(`  (${a.id})`));
        if (a.bio) console.log(`  ${a.bio}`);
        console.log();
      });
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

agentCommand
  .command('install [query]')
  .description('Search the marketplace and install an agent into a workspace')
  .option('--workspace <id>', 'Workspace id to install into (default: your personal workspace)')
  .action(async (query, options) => {
    try {
      const serverUrl = missionServerUrl();
      const authHeaders = missionAuthHeaders();
      const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);
      const workspaceId = workspace.id || workspace._id;

      let picked;
      if (query) {
        const results = await searchAgents(serverUrl, authHeaders, { query, workspaceId, limit: 10 });
        if (results.length === 0) throw new Error(`No marketplace agents found matching "${query}".`);
        if (!process.stdout.isTTY || !process.stdin.isTTY) {
          picked = results[0];
        } else {
          const { pickedAgent } = await inquirer.prompt([
            {
              type: 'select',
              name: 'pickedAgent',
              message: 'Install which agent?',
              choices: results.map((a) => ({ name: `${a.nickname || a.name}${a.bio ? chalk.gray(`  - ${a.bio}`) : ''}`, value: a })),
            },
          ]);
          picked = pickedAgent;
        }
      } else {
        picked = await installAgentInteractive(serverUrl, authHeaders, workspaceId);
        console.log(chalk.gray(`Installed into ${workspace.name || workspaceId}.`));
        return;
      }

      await pullAgentIntoWorkspace(serverUrl, authHeaders, { agentId: picked.id, workspaceId });
      console.log(chalk.green(`✅ Installed "${picked.nickname || picked.name}" into ${workspace.name || workspaceId}.`));
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

agentCommand
  .command('make')
  .description('Create a brand new AI Staff agent')
  .option('--name <name>', 'Agent name')
  .option('--nickname <nickname>', 'Agent nickname (used to @-mention/target it)')
  .option('--email <email>', 'Agent email')
  .option('--bio <bio>', 'Short bio')
  .option('--workspace <id>', 'Workspace to install the new agent into (default: your personal workspace)')
  .action(async (options) => {
    try {
      const serverUrl = missionServerUrl();
      const authHeaders = missionAuthHeaders();
      const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);

      const canPrompt = process.stdout.isTTY && process.stdin.isTTY;
      const answers = { name: options.name, nickname: options.nickname, email: options.email, bio: options.bio };
      if ((!answers.name || !answers.nickname || !answers.email) && canPrompt) {
        const prompted = await inquirer.prompt(
          [
            !answers.name && { type: 'input', name: 'name', message: 'Agent name:', validate: (v) => v.trim().length > 0 || 'Required' },
            !answers.nickname && {
              type: 'input',
              name: 'nickname',
              message: 'Agent nickname (used to @-mention/target it):',
              validate: (v) => v.trim().length > 0 || 'Required',
            },
            !answers.email && { type: 'input', name: 'email', message: 'Agent email:', validate: (v) => v.trim().length > 0 || 'Required' },
            !answers.bio && { type: 'input', name: 'bio', message: 'Short bio (optional):' },
          ].filter(Boolean),
        );
        Object.assign(answers, prompted);
      }
      if (!answers.name || !answers.nickname || !answers.email) {
        throw new Error('Usage: aivin agent make --name <name> --nickname <nickname> --email <email> [--bio <bio>]');
      }

      const agent = await createAgent(serverUrl, authHeaders, { ...answers, workspaceId: workspace.id || workspace._id });
      console.log(chalk.green(`✅ Created agent "${agent.nickname || agent.name}"!`));
      if (agent.id) console.log(chalk.gray(`   ID: ${agent.id}`));
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

agentCommand
  .command('publish [agentId]')
  .description('Publish an agent you own to the marketplace')
  .option('--workspace <id>', 'Workspace the agent lives in (default: your personal workspace)')
  .action(async (agentId, options) => {
    try {
      const serverUrl = missionServerUrl();
      const authHeaders = missionAuthHeaders();
      const workspace = await resolveWorkspace(serverUrl, authHeaders, options.workspace);

      if (!agentId) {
        const agents = workspace.agents || [];
        if (agents.length === 0) throw new Error(`Workspace "${workspace.name}" has no agents to publish.`);
        if (!process.stdout.isTTY || !process.stdin.isTTY) {
          throw new Error('Usage: aivin agent publish <agentId>');
        }
        const { pickedAgentId } = await inquirer.prompt([
          {
            type: 'select',
            name: 'pickedAgentId',
            message: 'Publish which agent?',
            choices: agents.map((a) => ({ name: a.nickname || a.name || a.id, value: a.id || a.agent_id })),
          },
        ]);
        agentId = pickedAgentId;
      }

      await publishAgent(serverUrl, authHeaders, { agentId, workspaceId: workspace.id || workspace._id });
      console.log(chalk.green(`✅ Published agent ${agentId} to the marketplace.`));
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

const projectCommand = program.command('project').description('Create, update, and delete projects within a workspace');

projectCommand
  .command('create [name]')
  .description('Create a new project in a workspace')
  .option('--workspace <id>', 'Workspace id (default: your personal workspace)')
  .action(async (name, options) => {
    try {
      name = await requireArg(name, { prompt: 'Project name:', usage: 'Usage: aivin project create <name>' });
      await createProjectCmd(name, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

projectCommand
  .command('update [id]')
  .description('Update a project (currently: rename)')
  .option('--workspace <id>', 'Workspace id (default: your personal workspace)')
  .option('--name <name>', 'New name')
  .action(async (id, options) => {
    try {
      id = await requireArg(id, { prompt: 'Project id:', usage: 'Usage: aivin project update <id> --name <new name>' });
      await updateProjectCmd(id, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

projectCommand
  .command('delete [id]')
  .description('Delete a project')
  .option('--workspace <id>', 'Workspace id (default: your personal workspace)')
  .action(async (id, options) => {
    try {
      id = await requireArg(id, { prompt: 'Project id to delete:', usage: 'Usage: aivin project delete <id>' });
      await deleteProjectCmd(id, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

export { validatePluginConfig, incrementVersion, validateMcpProxyConfig, buildDeploymentPayload, buildMcpManifest };

// Only parse argv when run directly (`aivin ...` / `node bin/cli.mjs ...`),
// not when this module is imported (e.g. by tests) - otherwise Commander
// would parse the importing process's argv and could call process.exit().
//
// `import.meta.url` is always the module's real (symlink-resolved) path, but `process.argv[1]` is
// whatever literal path launched it - through `npm link`'s global shim that's a symlink
// (~/AppData/Roaming/npm/node_modules/@aivin-labs/sdk/bin/cli.mjs -> this repo), which would never
// string-equal the resolved URL and silently skip program.parse() entirely (global `aivin` would
// do nothing at all). Resolve argv[1] through the same symlink before comparing.
function resolveIsMain() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (resolveIsMain()) {
  program.parse(process.argv);
}
