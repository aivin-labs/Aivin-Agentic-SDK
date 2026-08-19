import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SDKClient, type PluginIdentity } from './SDKClient';
import { invocationStorage } from './currentInvocation';
import { configureTransport } from '../grpc/GrpcInvoker';

const DEFAULT_BASE_URL = 'https://api.aivin.cloud';

/** Same `<client>-ak-<random>` shape `ApiKeyService.createApiKey` mints on the backend (and the CLI
 *  parses identically) - split off locally so callers don't have to whoami-round-trip just to learn
 *  which tenant their own key belongs to. */
function parseApiKeyClient(apiKey: string): string | undefined {
  const anchorIndex = apiKey.lastIndexOf('-ak-');
  return anchorIndex === -1 ? undefined : apiKey.slice(0, anchorIndex);
}

/** `aivin login <baseUrl>` writes `{ base_url, api_key, sdk_endpoint }` here - the one place the CLI
 *  keeps its active session, shared machine-wide across every plugin project (see README.md's
 *  Environment variables section). Missing/unreadable/malformed file -> no credentials from this
 *  source, not an error (the caller falls through to whatever else it tries). */
function readCliCredentials(): { base_url?: string; api_key?: string; sdk_endpoint?: string } {
  const credentialsPath = path.join(os.homedir(), '.aivin', 'credentials');
  if (!fs.existsSync(credentialsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  } catch {
    return {};
  }
}

export interface ApiKeyIdentity {
  apiKey: string;
  baseUrl: string;
  /** gRPC endpoint override saved by `aivin login`/`AIVIN_APIKEY` setups - undefined lets
   *  `configureTransport()`'s caller fall back to `SDK_ENDPOINT`/production, same as everywhere else. */
  sdkEndpoint?: string;
  client?: string;
}

/**
 * Resolves the credential a standalone (non-container) caller authenticates with - a genuine
 * third-party application using the Aivin platform's infrastructure directly through this SDK,
 * NOT a plugin running inside a host-spawned Docker container (those get `SDK_SECRET_FILE`/`cap`
 * injected automatically and never call this).
 *
 * Two sources, in priority order:
 * 1. `AIVIN_APIKEY` env var (+ `AIVIN_BASE_URL`, defaulting like the rest of this SDK does) - the
 *    explicit, CI/deploy-friendly way to hand a long-lived process its identity.
 * 2. `~/.aivin/credentials`, the same file `aivin login` already writes for the CLI (see
 *    README.md#environment-variables) - lets a local script piggyback on a developer's existing
 *    `aivin login` session with zero extra setup, matching this SDK's "zero config" default.
 *
 * Returns `undefined` (never throws) when neither source has anything - `mintStandaloneSession()`
 * is what turns that into a clear error, since a caller checking "am I logged in?" shouldn't have to
 * wrap this in try/catch to find out.
 */
export function resolveApiKeyIdentity(): ApiKeyIdentity | undefined {
  const envKey = process.env.AIVIN_APIKEY;
  if (envKey) {
    return {
      apiKey: envKey,
      baseUrl: process.env.AIVIN_BASE_URL || DEFAULT_BASE_URL,
      sdkEndpoint: process.env.SDK_ENDPOINT,
      client: parseApiKeyClient(envKey),
    };
  }
  const fromFile = readCliCredentials();
  if (fromFile.api_key && fromFile.base_url) {
    return {
      apiKey: fromFile.api_key,
      baseUrl: fromFile.base_url,
      sdkEndpoint: fromFile.sdk_endpoint,
      client: parseApiKeyClient(fromFile.api_key),
    };
  }
  return undefined;
}

export interface StandaloneSessionOptions {
  /** Identifies this application in the minted cap's claims and the underlying container-secret
   *  record - purely for logging/attribution on the backend, any stable string works. Defaults to
   *  `'sdk-standalone'`. */
  pluginId?: string;
  workspaceId?: string;
  projectId?: string;
  sessionId?: string;
  /** Capped server-side at 3600s regardless of what's requested here - see `mintSdkSession` on the
   *  backend. */
  ttlSec?: number;
}

export interface StandaloneSession {
  client: string;
  cap: string;
  workspaceId?: string;
  projectId?: string;
}

/**
 * Mints a real `cap`+`secret` pair for a standalone caller via `POST /plugins/sdk/session` - the
 * production sibling of the `mint-cap` mechanism `test-sdk` uses for QA (see that backend
 * controller's doc comment for the full picture). This is what turns an `AIVIN_APIKEY`/`aivin login`
 * credential into the same kind of identity a real plugin container gets automatically: calls
 * `configureTransport({ endpoint, secret })` so subsequent SDK calls authenticate as a real
 * container would, and returns the `cap`/`client` needed to build a `SDKClient`.
 *
 * Most callers want `connectStandalone()` below instead - this is exposed separately for callers
 * that want to manage the `SDKClient`/ambient-context binding themselves.
 */
export async function mintStandaloneSession(opts: StandaloneSessionOptions = {}): Promise<StandaloneSession> {
  const identity = resolveApiKeyIdentity();
  if (!identity) {
    throw new Error(
      '[@aivin-labs/sdk] No API key found for standalone use - set AIVIN_APIKEY, or run ' +
        '`aivin login <baseUrl>` once (saves to ~/.aivin/credentials). See ' +
        'docs/SDK.md#standalone-use-third-party-applications.',
    );
  }

  const res = await fetch(`${identity.baseUrl}/plugins/sdk/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${identity.apiKey}`,
      // Required for any request hitting the API host directly (CLI/SDK, not a tenant's own FE
      // domain) - without it, client resolution falls back to the Host header and never matches a
      // registered client, 403ing even with an otherwise-valid key. See ApiKeyService.createApiKey's
      // doc comment on the backend for the full explanation.
      ...(identity.client ? { 'x-client-slug': identity.client } : {}),
    },
    body: JSON.stringify({
      plugin_id: opts.pluginId ?? 'sdk-standalone',
      workspace_id: opts.workspaceId,
      project_id: opts.projectId,
      session_id: opts.sessionId,
      ttl_sec: opts.ttlSec,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[@aivin-labs/sdk] Failed to start standalone SDK session: HTTP ${res.status} ${text}`);
  }

  const { cap, client, secret } = (await res.json()) as { cap: string; client: string; secret: string };
  configureTransport({ endpoint: identity.sdkEndpoint, secret });
  return { client, cap, workspaceId: opts.workspaceId, projectId: opts.projectId };
}

/**
 * The standalone entry point for a third-party application: mints a session (see
 * `mintStandaloneSession`), builds a real `SDKClient` around it, and runs `fn` with that client bound
 * as the ambient invocation - so the recommended `import { ai } from '@aivin-labs/sdk'` top-level
 * style resolves correctly inside `fn`, exactly like it does inside a real plugin's `main()`.
 *
 * ```typescript
 * import { connectStandalone, ai } from '@aivin-labs/sdk';
 *
 * await connectStandalone(async () => {
 *   const summary = await ai.prompt('Summarize this for me');
 *   console.log(summary);
 * }, { workspaceId: 'ws_123' });
 * ```
 *
 * One session per call - a long-running process that needs to keep calling the SDK across many
 * separate `connectStandalone` calls will mint a fresh cap each time (cheap: one HTTP round trip,
 * no container spin-up involved). There is no automatic background refresh; a cap minted here is
 * only valid for the `ttlSec` given (capped at 3600s server-side).
 */
export async function connectStandalone<T>(
  fn: () => T | Promise<T>,
  opts: StandaloneSessionOptions = {},
): Promise<T> {
  const session = await mintStandaloneSession(opts);
  const identity: PluginIdentity = {
    client: session.client,
    workspace: session.workspaceId ? ({ id: session.workspaceId, client: session.client } as any) : undefined,
  };
  const client = new SDKClient(identity, { cap: session.cap });
  return invocationStorage.run(client, async () => fn());
}
