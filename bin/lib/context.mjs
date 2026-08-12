import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';

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
export const GLOBAL_CREDENTIALS_PATH = path.join(os.homedir(), '.aivin', 'credentials');

export const DEFAULT_AIVIN_BASE_URL = 'https://api.aivin.cloud';

/**
 * The REST API and the gRPC SDK channel are two different hostnames behind the same login (e.g.
 * `api.aivin.cloud` / `sdk.aivin.cloud` in production, `beta-api.aivin.vn` / `beta-sdk.aivin.vn` in
 * staging - proven consistent across both real environments this SDK talks to). Derived once at
 * login time by swapping the leading `api.` label for `sdk.`, so `SDK_ENDPOINT` never needs its own
 * separate manual config for the common case - same context, same command.
 */
export function deriveSdkEndpoint(baseUrl) {
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
export async function fetchWebUrl(baseUrl) {
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
export function loadActiveContext() {
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

export function saveActiveContext(baseUrl, apiKey) {
  fs.mkdirSync(path.dirname(GLOBAL_CREDENTIALS_PATH), { recursive: true });
  const sdkEndpoint = deriveSdkEndpoint(baseUrl);
  fs.writeFileSync(
    GLOBAL_CREDENTIALS_PATH,
    JSON.stringify({ base_url: baseUrl, api_key: apiKey, sdk_endpoint: sdkEndpoint }, null, 2) + '\n',
    { mode: 0o600 },
  );
  return sdkEndpoint;
}
