#!/usr/bin/env node
/**
 * Cross-checks this package's SDKClient.ts against the backend's real PluginBridge registrations,
 * to catch exactly the class of drift that caused today's real bugs (SDKClient.ts calling a
 * `namespace.method` that either doesn't exist on the backend, or exists but was never wired up
 * with typed sugar — forcing plugin authors onto the untyped `call()` escape hatch for no reason).
 *
 * This is a BEST-EFFORT STATIC SCAN via regex, not a full TypeScript AST parser — it will not catch
 * everything (in particular it cannot verify PARAM SHAPES, only which `namespace.method` strings
 * exist on each side; the `automation.createJob` bug fixed alongside this script had the right
 * namespace name but wrong param field names, which this tool would NOT have caught). Treat a
 * report from this script as "worth a manual look", not as ground truth on its own — always read
 * the actual backend handler before trusting either side's shape.
 *
 * Usage:
 *   node scripts/check-contract.mjs --be-path /path/to/be/src
 *   BE_REPO_PATH=/path/to/be node scripts/check-contract.mjs
 *
 * Exits non-zero (for CI) only when SDKClient.ts references a namespace.method with NO
 * corresponding backend registration at all (a genuinely broken/dead call) — a missing-sugar
 * finding (backend has it, SDKClient doesn't wrap it) is reported but does not fail the build,
 * since `call()` is a legitimate, supported way to reach it.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function parseArgs(argv) {
  const args = { bePath: process.env.BE_REPO_PATH };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--be-path' && argv[i + 1]) args.bePath = argv[++i];
  }
  return args;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Extracts every `namespace.method` string this package's SDKClient.ts actually calls. */
function extractSdkClientCalls(sdkClientPath) {
  const src = readFileSync(sdkClientPath, 'utf8');
  const calls = new Set();
  // this.call('namespace.method', ...) / this.call("namespace.method", ...)
  const re = /this\.call(?:Stream)?(?:<[^>]*>)?\(\s*['"]([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)['"]/g;
  let m;
  while ((m = re.exec(src))) calls.add(m[1]);
  // `this.invokeStream({ namespace: 'x.y', ... })` (e.g. ai.promptStream) doesn't go through
  // `this.call(...)` at all, so it needs its own pattern - namespace is an object literal property
  // instead of a direct call argument.
  const namespacePropRe = /namespace\s*:\s*['"]([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)['"]/g;
  while ((m = namespacePropRe.exec(src))) calls.add(m[1]);
  return calls;
}

/** Extracts every `namespace.method` the backend registers via PluginBridge.sdkFunction/
 *  sdkStreamFunction (namespace given as one dotted string) and .sdkMethods (prefix + method-name
 *  array, each entry either a bare string or `{ name, alias }`). */
function extractBackendRegistrations(beSrcRoot) {
  const registrations = new Set();
  const files = walk(beSrcRoot);

  const directRe = /PluginBridge\.sdk(?:Stream)?Function\(\s*['"]([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)['"]/g;
  // Captures the prefix and the raw array source; the array's own contents are parsed separately
  // below since entries can be bare strings OR `{ name: '...', alias: '...' }` objects.
  const bulkRe = /PluginBridge\.sdkMethods\(\s*[^,]+,\s*['"]([a-zA-Z0-9_]+)['"]\s*,\s*\[([\s\S]*?)\]\s*\)/g;
  const bulkEntryStringRe = /^\s*['"]([a-zA-Z0-9_]+)['"]\s*$/;
  const bulkEntryObjectAliasRe = /alias\s*:\s*['"]([a-zA-Z0-9_]+)['"]/;
  const bulkEntryObjectNameRe = /name\s*:\s*['"]([a-zA-Z0-9_]+)['"]/;
  // One-off pattern seen in AISDK.ts: a local `register(name, handler)` helper that calls
  // `PluginBridge.sdkFunction(\`prefix.${name}\`, handler)` internally, so the real namespace is
  // split across a template literal (unreadable statically on its own) and separate `register(...)`
  // call sites. Detect the template-literal prefix, then pair it with every bare-string first
  // argument passed to whatever the helper function is named. If a new file adopts this same
  // "wrapper + registered name list" trick with a different helper name, extend this list.
  const templatePrefixRe = /PluginBridge\.sdk(?:Stream)?Function\(\s*`([a-zA-Z0-9_]+)\.\$\{[a-zA-Z0-9_]+\}`/g;
  const helperCallRe = /\bregister\(\s*['"]([a-zA-Z0-9_]+)['"]/g;

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('PluginBridge')) continue;

    let m;
    directRe.lastIndex = 0;
    while ((m = directRe.exec(src))) registrations.add(m[1]);

    bulkRe.lastIndex = 0;
    while ((m = bulkRe.exec(src))) {
      const prefix = m[1];
      // Split the array body on top-level commas is unreliable with nested `{...}` entries, so
      // instead split on `},` / `,` boundaries loosely — good enough for the flat, shallow arrays
      // this pattern is actually used with in practice (see this script's own doc comment on
      // "best-effort", not an AST parser).
      const rawEntries = m[2].split(/,(?![^{]*\})/).map((s) => s.trim()).filter(Boolean);
      for (const entry of rawEntries) {
        const bare = entry.match(bulkEntryStringRe);
        if (bare) {
          registrations.add(`${prefix}.${bare[1]}`);
          continue;
        }
        const alias = entry.match(bulkEntryObjectAliasRe);
        const name = entry.match(bulkEntryObjectNameRe);
        if (alias) registrations.add(`${prefix}.${alias[1]}`);
        else if (name) registrations.add(`${prefix}.${name[1]}`);
      }
    }

    templatePrefixRe.lastIndex = 0;
    const templatePrefixes = [];
    while ((m = templatePrefixRe.exec(src))) templatePrefixes.push(m[1]);
    if (templatePrefixes.length > 0) {
      helperCallRe.lastIndex = 0;
      while ((m = helperCallRe.exec(src))) {
        for (const prefix of templatePrefixes) registrations.add(`${prefix}.${m[1]}`);
      }
    }
  }
  return registrations;
}

function main() {
  const { bePath } = parseArgs(process.argv.slice(2));
  if (!bePath) {
    console.error(
      'Missing backend repo path. Pass --be-path <path-to-be-repo-or-its-src> or set BE_REPO_PATH.',
    );
    process.exit(2);
  }
  const beSrcRoot = existsSync(join(bePath, 'src')) ? join(bePath, 'src') : bePath;
  if (!existsSync(beSrcRoot)) {
    console.error(`Backend src root not found: ${beSrcRoot}`);
    process.exit(2);
  }

  const sdkClientPath = resolve(__dirname, '../src/sdk/SDKClient.ts');
  const sdkCalls = extractSdkClientCalls(sdkClientPath);
  const backendRegistrations = extractBackendRegistrations(beSrcRoot);

  const deadInSdkClient = [...sdkCalls].filter((c) => !backendRegistrations.has(c)).sort();
  const missingSugar = [...backendRegistrations].filter((c) => !sdkCalls.has(c)).sort();

  console.log(`Scanned ${sdkCalls.size} SDKClient.ts call site(s) against ${backendRegistrations.size} backend registration(s).\n`);

  if (deadInSdkClient.length > 0) {
    console.log(`❌ SDKClient.ts calls with NO matching backend registration (${deadInSdkClient.length}) — likely broken, or this scan's regex missed the real registration (check manually before assuming SDKClient.ts is wrong):`);
    for (const c of deadInSdkClient) console.log(`   - ${c}`);
    console.log('');
  } else {
    console.log('✅ Every SDKClient.ts call site matched a backend registration.\n');
  }

  if (missingSugar.length > 0) {
    console.log(`ℹ️  Backend registrations with no SDKClient.ts sugar (${missingSugar.length}) — reachable via the generic call() escape hatch; consider adding typed sugar if plugin authors reach for these often:`);
    for (const c of missingSugar) console.log(`   - ${c}`);
    console.log('');
  }

  console.log(
    'Reminder: this only checks namespace.method NAMES exist on both sides, not param shapes — ' +
      "always read the backend handler before trusting a signature. See this script's header comment.",
  );

  process.exit(deadInSdkClient.length > 0 ? 1 : 0);
}

main();
