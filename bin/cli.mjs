#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { spawn, exec, execSync } from 'child_process';
import axios from 'axios';
import http from 'http';
import os from 'os';
import dotenv from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
// Same flatten logic PluginServer.ts uses for local/production runtime resolution - imported from
// the built output (not src/) so deploy and runtime agree on exactly the same rules for what
// manifest.json's { ...commonFields, plugins: [...] } authoring shape expands into.
import { flattenManifestFile } from '../dist/types/PluginTypes.js';

// `~/.aivin/credentials` - written once by `aivin login`, read by every plugin project on this
// machine. `API_KEY` used to only ever get saved to the current project's `.env`, meaning every
// separate project directory needed its own `aivin login` (and minted its own separate key) even
// though the credential is really a per-machine thing, not a per-project one.
const GLOBAL_CREDENTIALS_PATH = path.join(os.homedir(), '.aivin', 'credentials');

// Load env vars: the current project's `.env` first (SDK_GRPC_ENDPOINT, AIVIN_WEB_URL, and any
// deliberate per-project API_KEY override), then the global credentials file as a fallback for
// API_KEY specifically. `dotenv.config()` never overrides a variable that's already set, so a
// project's own `.env` (or a real shell env var) always wins over the global fallback.
// `quiet: true` - otherwise dotenv prints an "injected env" tip line to stdout on every run,
// which would corrupt `--json-output` mode (meant for clean, parseable JSON on stdout).
dotenv.config({ quiet: true });
if (fs.existsSync(GLOBAL_CREDENTIALS_PATH)) {
  dotenv.config({ path: GLOBAL_CREDENTIALS_PATH, quiet: true });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const program = new Command();

program.name('aivin').description('Aivin Plugin SDK - Build and run AI plugins').version('1.0.0');

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
  .description('Validate JSON config')
  .option('--json <config>', 'JSON config')
  .option('--stdin', 'From stdin')
  .option('--json-output', 'JSON output')
  .action(async (options) => {
    try {
      let configData;

      if (options.stdin) {
        configData = await readStdin();
      } else if (options.json) {
        configData = options.json;
      } else {
        throw new Error('Need --json or --stdin');
      }

      const config = JSON.parse(configData);
      const result = validatePluginConfig(config);

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
) {
  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true });
  }

  await Promise.all([
    createManifest(pluginDir, name, description, aiConfig),
    createHandler(pluginDir, aiConfig),
    createPackageJson(pluginDir, name, description, currentPackageJson),
    createTsConfig(pluginDir),
    createEnv(pluginDir),
    createGitignore(pluginDir),
  ]);
}

async function createGitignore(pluginDir) {
  const gitignorePath = path.join(pluginDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) return;

  const content = ['node_modules/', 'dist/', '.env', '.env.*', '*.log', '.test/', ''].join('\n');
  fs.writeFileSync(gitignorePath, content);
}

async function createManifest(pluginDir, name, description, aiConfig) {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  let currentManifest = null;
  if (fs.existsSync(manifestPath)) {
    currentManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }

  // Matches the backend's DeveloperPluginManifest (src/plugins/dto/PluginDTO.ts) - `id` is a
  // local placeholder until the plugin is first deployed, at which point the server assigns
  // (and this CLI writes back) the real one.
  const newManifest = {
    id: randomBytes(16).toString('hex'),
    name,
    description,
    version: '1.0.0',
    author: '',
    email: '',
    input: {
      data: 'object - Input data for processing',
    },
    output: {
      data: 'object - Processed data result',
    },
    trigger_type: ['manual', 'api', 'chat'],
    initial: {},

    ...currentManifest,
    ...(aiConfig || {}),
  };

  fs.writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2));
}

async function createHandler(pluginDir, aiConfig) {
  const header =
    '// Import just the namespace(s) you need - see docs/SDK.md for the full list\n' +
    '// (ai, vector, knowledge, task, store, redis, mongo, workspace, agent, realtime, queue, ...).\n' +
    "// ctx.sdk.<namespace> and `import SDK from '@aivin-labs/sdk'` work identically.\n" +
    "import { ai } from '@aivin-labs/sdk';\n" +
    "import type { PluginInput, PluginContext, PluginResponse } from '@aivin-labs/sdk';\n" +
    "import { PluginStatus, PluginErrorCode } from '@aivin-labs/sdk';";

  let handlerContent;

  if (aiConfig && aiConfig.handlerCode) {
    handlerContent = `${header}\n\n${aiConfig.handlerCode}\n`;
  } else {
    // Single entry point - the host always calls `main` (or the default export as a fallback).
    // For a multi-function plugin, export as many named functions as you like here and list each
    // one's `func` in manifest.json's `plugins: [...]` - see docs/MANIFEST.md#multi-function-plugins.
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
    },
    dependencies: {
      '@aivin-labs/sdk': 'latest',
    },
    devDependencies: {
      '@types/node': 'latest',
      typescript: 'latest',
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
    '# ctx.sdk.* calls default to the production backend (api.aivin.cloud) if this is left unset -',
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
  .action(() => {
    const serverPath = path.join(__dirname, 'server.mjs');
    const child = spawn('node', [serverPath], {
      stdio: 'inherit',
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
 * Calls the real AI code generator (POST /code/generate - CodeHandler.generateCode on the
 * frontend, same endpoint the browser CodeEditor uses). That endpoint's default output already
 * targets `main(mission, input, ctx)` + `ctx.sdk.*` + `PluginResponse` - the same conventions this
 * Docker-runtime SDK uses - so the prompt below is reinforcement, not an override.
 */
async function makePluginFromDescription(description, options = {}) {
  const currentDir = process.cwd();
  const manifestPath = path.join(currentDir, 'manifest.json');
  const handlerPath = path.join(currentDir, 'src', 'main.ts');

  if (!fs.existsSync(manifestPath)) {
    throw new Error('manifest.json not found. Run `aivin create` first.');
  }

  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const sdkConventionPreamble = `Write an Aivin plugin handler.
Rules:
- Export exactly one async function: export async function main(mission: string, input: PluginInput, ctx: PluginContext): Promise<PluginResponse> { ... }
- "input" fields come from the manifest's "input" description. "mission" is why this run was triggered (for logging, not routing).
- Preferred: import only the namespace(s) you need directly, e.g. import { ai, vector, task, store, redis, mongo } from '@aivin-labs/sdk'; then call ai.prompt(...), vector.search(...), task.create(...), store.set(...), redis.get(...), mongo.model(name).find(...). Only fall back to import { call } from '@aivin-labs/sdk'; call(namespace, params) if no sugar method fits.
- Return { status: PluginStatus.SUCCESS, data, message } on success, or { status: PluginStatus.ERROR, message, error_code: PluginErrorCode.XXX } on failure.
- Import types from '@aivin-labs/sdk': import type { PluginInput, PluginContext, PluginResponse } from '@aivin-labs/sdk'; import { PluginStatus, PluginErrorCode } from '@aivin-labs/sdk';

Business requirement:
${description}`;

  console.log(chalk.blue('🤖 Generating src/main.ts...'));

  let response;
  try {
    response = await axios.post(
      `${serverUrl}/code/generate`,
      {
        // Deliberately no `workspace_files` - sending one (even `aivin create`'s generic
        // placeholder src/main.ts) switches the backend into "surgical edit" mode, which returns a
        // unified-diff patch instead of plain source when its own hunk-reconstruction can't fully
        // apply (confirmed: the placeholder is worthless context anyway, and every `aivin create`
        // scaffold ships one, so this hit on every normal `aivin plugin make` call, writing a raw
        // { mode: "diff", hunks: [...] } JSON blob into src/main.ts instead of code). A fresh
        // generation produces the same quality logic without any of that fragility.
        //
        // target_file: 'src/main.ts' matches the backend's own "MAIN ENTRY POINT" prompt branch
        // (CodeGenerationHelper.ts) - the real convention for this filename, confirmed by both the
        // backend's workspace template and the browser CodeEditor.
        logic: sdkConventionPreamble,
        code_id: manifest.id,
        target_file: 'src/main.ts',
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
  // Defensive check: a { "mode": "diff"|"full", "hunks"/"content": ... } blob is the backend's
  // internal patch format, never meant to reach here as-is - fail loudly instead of writing an
  // unusable file if this ever slips through again.
  const looksLikeDiffBlob = /^\s*\{\s*"mode"\s*:\s*"(diff|full)"/.test(result.code);
  if (looksLikeDiffBlob) {
    throw new Error(
      'Aivin server returned an internal patch format instead of plain code - this is a server-side bug, not something to write to src/main.ts. Please report it.',
    );
  }

  fs.mkdirSync(path.dirname(handlerPath), { recursive: true });
  fs.writeFileSync(handlerPath, result.code);
  console.log(chalk.green('✅ src/main.ts generated'));

  applyGeneratedManifestFields(manifestPath, manifest, result);

  console.log(chalk.cyan('\n🔧 Next steps:'));
  console.log('   aivin start   # test locally');
  console.log('   aivin test    # deploy to a test instance');
}

/** Shared by `plugin make`/`plugin convert` - fills in whatever manifest fields the AI inferred
 *  alongside the code, but only ones you haven't already set yourself. */
function applyGeneratedManifestFields(manifestPath, manifest, result) {
  let manifestChanged = false;
  if (result.description && !manifest.description) {
    manifest.description = result.description;
    manifestChanged = true;
  }
  const instructions = result.instructions || result.instruction;
  if (instructions && !manifest.instructions) {
    manifest.instructions = instructions;
    manifestChanged = true;
  }
  const inputSchema = result.input || result.input_schema;
  if (inputSchema && (!manifest.input || Object.keys(manifest.input).length === 0)) {
    manifest.input = inputSchema;
    manifestChanged = true;
  }
  if (manifestChanged) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(chalk.green('✅ manifest.json enriched from generated result'));
  }
}

// Same dirs/files `aivin deploy` already ignores, plus lockfiles and anything with no value as AI
// context (binary-ish assets) - this is prompt context, not a file we upload anywhere.
const CONVERT_EXCLUDE_DIRS = [...DEPLOY_EXCLUDE_DIRS, 'coverage', '.next', '.cache', '.vscode', '.idea'];
const CONVERT_EXCLUDE_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.gitignore'];
const CONVERT_BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|zip|tar|gz|pdf|mp4|mp3|wasm|node)$/i;
const CONVERT_MAX_FILE_BYTES = 30_000; // skip individual files bigger than this - noise, not signal
const CONVERT_MAX_TOTAL_BYTES = 250_000; // stay well under the server's 5MB/200-file hard cap

/**
 * Gathers the existing project's own source as AI context for `plugin convert` - explicitly
 * excludes `manifestPath`/`handlerPath` themselves (the files this command is about to write) so
 * neither can ever end up as a `workspace_files` key, which is what would trip the backend's
 * surgical-edit/diff mode (see the comment in `makePluginFromDescription` above). Stops adding
 * files once `CONVERT_MAX_TOTAL_BYTES` is reached rather than failing - partial context is still
 * useful context.
 */
function gatherConversionContext(dir, manifestPath, handlerPath, basePath = '', budget = { used: 0 }) {
  const files = {};
  const items = fs.readdirSync(dir);

  for (const item of items) {
    if (budget.used >= CONVERT_MAX_TOTAL_BYTES) break;
    const fullPath = path.join(dir, item);
    const relativePath = path.join(basePath, item);
    if (fullPath === manifestPath || fullPath === handlerPath) continue;
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      if (!CONVERT_EXCLUDE_DIRS.includes(item)) {
        Object.assign(files, gatherConversionContext(fullPath, manifestPath, handlerPath, relativePath, budget));
      }
    } else if (
      !CONVERT_EXCLUDE_FILES.includes(item) &&
      !isEnvFile(item) &&
      !CONVERT_BINARY_EXT.test(item) &&
      stat.size > 0 &&
      stat.size <= CONVERT_MAX_FILE_BYTES &&
      budget.used + stat.size <= CONVERT_MAX_TOTAL_BYTES
    ) {
      const content = fs.readFileSync(fullPath, 'utf8');
      files[relativePath.split(path.sep).join('/')] = content;
      budget.used += stat.size;
    }
  }

  return files;
}

/**
 * `aivin plugin convert` - same real AI code generator as `plugin make`, but instead of writing
 * src/main.ts from a plain-language description, it reads the existing project in the current
 * directory as context and asks the AI to adapt/wrap its own logic into one instead. Point it at a
 * project you already have and it becomes an Aivin plugin without you writing the wrapper by hand.
 */
async function convertExistingProject(hint, options = {}) {
  const currentDir = process.cwd();
  const manifestPath = path.join(currentDir, 'manifest.json');
  const handlerPath = path.join(currentDir, 'src', 'main.ts');

  if (fs.existsSync(handlerPath)) {
    throw new Error('src/main.ts already exists - `plugin convert` is for a project that isn\'t an Aivin plugin yet.');
  }

  let manifest;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } else {
    // No `aivin create` needed first - infer a starting manifest from package.json (or the
    // directory name) so there's less setup between "I have a project" and "it's a plugin".
    let pkg = null;
    const pkgPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { /* not JSON we can use */ }
    }
    const name = (pkg?.name || path.basename(currentDir)).replace('@aivin/plugin-', '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    manifest = {
      id: randomBytes(16).toString('hex'),
      name,
      description: pkg?.description || '',
      version: '1.0.0',
      author: '',
      email: '',
      input: {},
      initial: {},
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(chalk.green('✅ manifest.json created'), chalk.gray(`(name: ${name})`));
  }

  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.log(chalk.yellow('⚠️  API_KEY not set - run `aivin login` first'));
  }

  console.log(chalk.blue('📂 Reading the existing project for context...'));
  const workspaceFiles = gatherConversionContext(currentDir, manifestPath, handlerPath);
  const fileCount = Object.keys(workspaceFiles).length;
  if (fileCount === 0) {
    throw new Error('No source files found to convert in the current directory.');
  }
  console.log(chalk.gray(`   ${fileCount} file(s) included as context`));

  const conventionPreamble = `Convert this existing project into an Aivin plugin.
Rules:
- Export exactly one async function: export async function main(mission: string, input: PluginInput, ctx: PluginContext): Promise<PluginResponse> { ... }
- Analyze the provided project files (below, as workspace context) and adapt its real, existing logic into that one function - don't just stub it out. Preserve its actual behavior.
- Map "input" to whatever parameters the project's core logic already takes.
- Preferred: import only the namespace(s) you need directly from '@aivin-labs/sdk', e.g. import { ai, vector, task, store, redis, mongo } from '@aivin-labs/sdk'. Only use import { call } from '@aivin-labs/sdk'; call(namespace, params) if no sugar method fits.
- Return { status: PluginStatus.SUCCESS, data, message } on success, or { status: PluginStatus.ERROR, message, error_code: PluginErrorCode.XXX } on failure.
- Import types from '@aivin-labs/sdk': import type { PluginInput, PluginContext, PluginResponse } from '@aivin-labs/sdk'; import { PluginStatus, PluginErrorCode } from '@aivin-labs/sdk';
- If the project talks to a real external service (a database, a paid API, ...), replace that connection code with the closest '@aivin-labs/sdk' equivalent (store/redis/mongo for data, ai for LLM calls) rather than trying to keep raw credentials - plugins never receive them.
${hint ? `\nAdditional guidance from the developer:\n${hint}` : ''}`;

  console.log(chalk.blue('🤖 Generating src/main.ts from your existing code...'));

  let response;
  try {
    response = await axios.post(
      `${serverUrl}/code/generate`,
      {
        logic: conventionPreamble,
        code_id: manifest.id,
        target_file: 'src/main.ts',
        // The existing project's own files, as context - deliberately never includes 'src/main.ts'
        // itself (gatherConversionContext excludes handlerPath), since a workspace_files entry for
        // the file being generated is what switches the backend into surgical-edit/diff mode - see
        // the comment in makePluginFromDescription above.
        workspace_files: workspaceFiles,
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
      'Aivin server returned an internal patch format instead of plain code - this is a server-side bug, not something to write to src/main.ts. Please report it.',
    );
  }

  fs.mkdirSync(path.dirname(handlerPath), { recursive: true });
  fs.writeFileSync(handlerPath, result.code);
  console.log(chalk.green('✅ src/main.ts generated from your existing project'));

  applyGeneratedManifestFields(manifestPath, manifest, result);

  console.log(chalk.yellow('\n⚠️  Review the generated code before deploying - it\'s a starting point, not a guarantee.'));
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
 * Real-time log streaming (like the browser Playground's live panel) isn't available here - that
 * goes over a Socket.IO channel that only authenticates browser session JWTs, not CLI API keys, so
 * this only has what `/plugins/execute`'s response itself carries: `processing_log` (the mapping/
 * execution stage messages, all at once, not the plugin's own internal console output) and
 * `mapped_arguments` (only present when `-a` was used).
 */
async function triggerPlugin(mission, inputJson, options) {
  const currentDir = process.cwd();
  const manifestPath = path.join(currentDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('manifest.json not found. Run this from your plugin\'s directory.');
  }

  const manifest = flattenManifestFile(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  const entry = resolveTriggerEntry(manifest, options.func);

  const body = { plugin_id: entry.id };
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
      throw new Error(
        'Usage: aivin plugin trigger "<mission>" \'<input JSON>\'  (or: aivin plugin trigger -a "<prompt>")',
      );
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

  let workspaceId = options.workspace;
  if (!workspaceId) {
    try {
      const wsRes = await axios.get(`${serverUrl}/workspace/list`, authHeaders);
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

  console.log(chalk.blue(`🚀 Triggering ${entry.name}${entry.func ? ` [${entry.func}]` : ''}...`));

  let response;
  try {
    response = await axios.post(`${serverUrl}/plugins/execute`, body, authHeaders);
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Trigger failed: ${message}`, { cause: error });
  }

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

  if (!ok) process.exitCode = 1;
}

const pluginCommand = program.command('plugin').description('AI-assisted plugin authoring');

pluginCommand
  .command('make <description>')
  .description('Generate src/main.ts from a natural-language business description')
  .option('--model <model>', 'LLM model to use for generation')
  .option('--provider <provider>', 'LLM provider to use for generation')
  .action(async (description, options) => {
    try {
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
  .option('--func <name>', 'Which function to trigger, for a multi-function plugin (matches name/func/id)')
  .option('--workspace <id>', 'Workspace id to run against (default: auto-picks your first one)')
  .option('--agent <id>', 'Agent id to run as, if the plugin needs one for HIL/confirm behavior to be accurate')
  .action(async (mission, input, options) => {
    try {
      await triggerPlugin(mission, input, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
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
        type: 'list',
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
        type: 'list',
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

const mcpCommand = program
  .command('mcp')
  .description('MCP proxy plugins - wrap an external MCP server tool/resource/prompt, no code required');

mcpCommand
  .command('create <name>')
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
      await createMcpProxyPlugin(name, options);
    } catch (error) {
      console.error(chalk.red('❌'), error.message);
      process.exit(1);
    }
  });

// ── Login - get an API key saved once, machine-wide ─────────────────────────

/**
 * Writes to `~/.aivin/credentials`, not the current project's `.env` - a login is a per-machine
 * credential, not a per-project one, so `aivin login` only needs to happen once regardless of how
 * many plugin projects you work in on this machine. A project's own `.env` can still set `API_KEY`
 * directly to override this for a specific project (e.g. CI using a scoped key) - see the
 * dotenv.config() precedence at the top of this file.
 */
function saveGlobalApiKey(apiKey) {
  fs.mkdirSync(path.dirname(GLOBAL_CREDENTIALS_PATH), { recursive: true });
  fs.writeFileSync(GLOBAL_CREDENTIALS_PATH, `API_KEY=${apiKey}\n`, { mode: 0o600 });
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
 * `aivin login --basic`: prompts for email/password directly in the terminal, no browser. Only
 * supports the platform's default/shared client (`--client`, falls back to the same 'aivin.vn'
 * default the web app itself falls back to when no custom-domain org is resolved) - accounts under
 * a custom-domain organization need that domain resolved first, which is exactly what the web
 * login page normally does. Use the default `aivin login` (browser) flow for those.
 */
async function basicLogin(options) {
  const serverUrl = process.env.AIVIN_BASE_URL || 'https://api.aivin.cloud';
  const client = options.client || 'aivin.vn';

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

  let accessToken;
  try {
    const loginRes = await axios.post(`${serverUrl}/user/login`, {
      client,
      email: answers.email,
      nickname: answers.email.toLowerCase(),
      password: answers.password,
      auth_type: 'basic',
      auth_provider: 'tenant',
    });
    accessToken = loginRes.data?.access_token;
    if (!accessToken) throw new Error('Login response did not include an access token');
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Login failed: ${message}`, { cause: error });
  }

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
  .description('Log in and save an API key for plugin deployment (opens your browser by default)')
  .option('-k, --api-key <key>', 'Set API key directly (skip login entirely)')
  .option('--basic', 'Log in with email/password directly in the terminal instead of a browser')
  .option('--google', 'Alias of the default browser flow - pick Google once the page opens')
  .option('--client <client>', 'Client/org id to use with --basic (default: "aivin.vn")')
  .action(async (options) => {
    try {
      if (options.apiKey) {
        console.log(chalk.blue('🔑 Setting API key...'));
        saveGlobalApiKey(options.apiKey);
        console.log(chalk.green('✅ API key set successfully!'));
        console.log(chalk.yellow('🔑 Your API Key:'), chalk.cyan(options.apiKey));
        console.log(chalk.green(`💾 Saved to ${GLOBAL_CREDENTIALS_PATH} - every project on this machine can use it now.`));
        return;
      }

      const apiKey = options.basic ? await basicLogin(options) : await browserLogin();

      console.log(chalk.green('✅ Login successful!'));
      saveGlobalApiKey(apiKey);
      console.log(chalk.green(`💾 Saved to ${GLOBAL_CREDENTIALS_PATH} - every project on this machine can use it now.`));
    } catch (error) {
      console.log(chalk.red('❌ Login failed:'), error.message);
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
