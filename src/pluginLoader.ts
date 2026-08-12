import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { PluginManifest, MultiFunctionManifestEntry, flattenManifestFile } from './types/PluginTypes';
import { PluginContext, PluginInput } from './types/SDKTypes';

export interface LoadedPlugin {
  /** A plain object for a single-function plugin, or - once `manifest.json`'s on-disk
   *  `{ ...commonFields, plugins: [...] }` shape has been flattened - an array (each entry naming
   *  which export in src/main.ts implements it via `func`) for a multi-function plugin. */
  manifest: PluginManifest | MultiFunctionManifestEntry[];
  /** The raw `src/main.ts` module namespace - kept as-is (not pre-resolved to a single function)
   *  so multi-function plugins can look up any of its named exports by name. */
  handler: any;
}

/**
 * Reads and flattens `manifest.json` only - no `src/main.ts` import. Used anywhere that just needs
 * id/name/version (e.g. a hot-reload summary line) without paying for a full module load, and as
 * the first half of `loadPluginModule` below.
 */
export function readManifest(pluginsPath: string): PluginManifest | MultiFunctionManifestEntry[] {
  const manifestPath = path.join(pluginsPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json not found in: ${pluginsPath}`);
  }
  return flattenManifestFile(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
}

/**
 * Loads a plugin project from disk: `manifest.json` (flattened) + a dynamic import of
 * `src/main.ts`. Shared between `PluginServer` (direct, in-process load) and
 * `worker/PluginWorkerRuntime` (same load, running inside a sandboxed worker thread instead) -
 * kept in one place so the two paths can't silently diverge in how they resolve a plugin project.
 */
export async function loadPluginModule(pluginsPath: string, cacheBust = false): Promise<LoadedPlugin> {
  const manifestPath = path.join(pluginsPath, 'manifest.json');
  const entryPath = path.join(pluginsPath, 'src', 'main.ts');

  if (!fs.existsSync(manifestPath) || !fs.existsSync(entryPath)) {
    throw new Error(`Plugin files not found. Expected manifest.json and src/main.ts in: ${pluginsPath}`);
  }

  const manifest = readManifest(pluginsPath);

  // Dynamic import to load src/main.ts as native ESM/TS (Node's native TypeScript support,
  // >=22.6). Routed through `new Function` so TS's CommonJS downlevel of `import()` (a
  // require()-based helper that can't load a real ESM/.ts file) is bypassed - see the SDK
  // README for the full rationale.
  const absolutePath = path.resolve(entryPath);
  // Node's ESM module cache is keyed by the full specifier (including query string), not just
  // the file path - `?t=<timestamp>` on a reload forces a genuinely fresh import instead of
  // silently handing back the stale, already-cached module for the same `file://` path. Omitted
  // on the normal first load so a plain repeated call still short-circuits without ever reaching
  // this at all.
  const importPath = pathToFileURL(absolutePath).href + (cacheBust ? `?t=${Date.now()}` : '');
  const dynamicImport = new Function('specifier', 'return import(specifier)');
  // Kept as the raw module namespace (not pre-resolved to `.default`) - a multi-function plugin
  // needs to look up ANY of its named exports by name, not just one.
  const handler = await dynamicImport(importPath);

  return { manifest, handler };
}

/** Display-friendly id/name/version for logging - handles both single-object and
 *  multi-function-array manifest shapes. */
export function summarizeManifest(
  manifest: PluginManifest | MultiFunctionManifestEntry[],
): { id: string; name: string; version: string } {
  if (Array.isArray(manifest)) {
    return {
      id: manifest.map((m) => m.id).join(', '),
      name: `${manifest.length} functions (${manifest.map((m) => m.func).join(', ')})`,
      version: manifest[0]?.version ?? '0.0.0',
    };
  }
  return { id: manifest.id, name: manifest.name, version: manifest.version ?? '0.0.0' };
}

/**
 * Resolves which exported function in `src/main.ts` to call for this invocation.
 *
 * - `explicitFunc` given (a real host invocation of a multi-function plugin): calls
 *   `handler[explicitFunc]` directly. No local manifest lookup needed - the host already resolved
 *   which entry this is.
 * - `plugins[]` manifest (array) with no `explicitFunc` - local dev/curl testing, no real host in
 *   the loop: a single-entry manifest resolves straight to its one entry; otherwise finds the
 *   entry whose `id` matches `mission`, or failing that whose `func` matches `mission` directly,
 *   and calls its `func`.
 * - Single-function plugin (manifest is one object): `main` export, then default export, then the
 *   first exported function - `mission` is just a human-readable label here, not routing.
 */
export function resolveTargetFunction(
  plugin: LoadedPlugin,
  mission: string,
  explicitFunc?: string,
): (mission: string, input: PluginInput, ctx: PluginContext) => any {
  const { handler, manifest } = plugin;

  if (explicitFunc) {
    const fn = handler[explicitFunc];
    if (typeof fn !== 'function') {
      throw new Error(
        `Host requested func "${explicitFunc}", but src/main.ts does not export a function with that name.`,
      );
    }
    return fn;
  }

  if (Array.isArray(manifest)) {
    const entry =
      manifest.length === 1
        ? manifest[0]
        : (manifest.find((m) => m.id === mission) ?? manifest.find((m) => m.func === mission));
    if (!entry) {
      const known = manifest.map((m) => `${m.id} -> ${m.func}`).join(', ');
      throw new Error(
        `No function matches "${mission}" in this multi-function plugin. Known id -> func mappings: ${known}`,
      );
    }
    const fn = handler[entry.func];
    if (typeof fn !== 'function') {
      throw new Error(
        `manifest.json declares func "${entry.func}" for plugin "${entry.id}", but src/main.ts does not export a function with that name.`,
      );
    }
    return fn;
  }

  if (typeof handler.main === 'function') return handler.main;
  if (typeof handler.default === 'function') return handler.default;
  const firstFn = Object.keys(handler).find((key) => typeof handler[key] === 'function');
  if (firstFn) return handler[firstFn];

  throw new Error(`No executable entry point found in plugin ${(manifest as PluginManifest).name}`);
}
