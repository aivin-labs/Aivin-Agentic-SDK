import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveApiKeyIdentity,
  mintStandaloneSession,
  connectStandalone,
} from '../src/sdk/standalone';
import { getCurrentSDK } from '../src/sdk/currentInvocation';

/** Points `os.homedir()` (what `readCliCredentials()` reads `~/.aivin/credentials` relative to) at
 *  a throwaway temp dir for the duration of the test, restoring the real value afterwards - avoids
 *  ever touching a real `~/.aivin/credentials` file on the machine running this suite. */
function withFakeHome<T>(credentials: object | undefined, fn: () => T): T {
  const homeEnvVar = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const original = process.env[homeEnvVar];
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aivin-sdk-test-home-'));
  process.env[homeEnvVar] = tmpHome;
  try {
    if (credentials) {
      const dir = path.join(tmpHome, '.aivin');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'credentials'), JSON.stringify(credentials));
    }
    return fn();
  } finally {
    if (original === undefined) delete process.env[homeEnvVar];
    else process.env[homeEnvVar] = original;
  }
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    originals[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  }
}

test('resolveApiKeyIdentity: AIVIN_APIKEY takes priority over ~/.aivin/credentials', () => {
  withFakeHome({ base_url: 'https://file.example.com', api_key: 'file-client-ak-fromfile' }, () => {
    withEnv({ AIVIN_APIKEY: 'acme-ak-fromenv', AIVIN_BASE_URL: 'https://env.example.com' }, () => {
      const identity = resolveApiKeyIdentity();
      assert.equal(identity?.apiKey, 'acme-ak-fromenv');
      assert.equal(identity?.baseUrl, 'https://env.example.com');
      assert.equal(identity?.client, 'acme');
    });
  });
});

test('resolveApiKeyIdentity: falls back to ~/.aivin/credentials when AIVIN_APIKEY is unset', () => {
  withFakeHome(
    { base_url: 'https://file.example.com', api_key: 'acme-ak-fromfile', sdk_endpoint: 'sdk.example.com:443' },
    () => {
      withEnv({ AIVIN_APIKEY: undefined }, () => {
        const identity = resolveApiKeyIdentity();
        assert.equal(identity?.apiKey, 'acme-ak-fromfile');
        assert.equal(identity?.baseUrl, 'https://file.example.com');
        assert.equal(identity?.sdkEndpoint, 'sdk.example.com:443');
        assert.equal(identity?.client, 'acme');
      });
    },
  );
});

test('resolveApiKeyIdentity: returns undefined when neither source has credentials', () => {
  withFakeHome(undefined, () => {
    withEnv({ AIVIN_APIKEY: undefined }, () => {
      assert.equal(resolveApiKeyIdentity(), undefined);
    });
  });
});

test('mintStandaloneSession: throws a clear error when not authenticated', async () => {
  await withFakeHome(undefined, () =>
    withEnv({ AIVIN_APIKEY: undefined }, () =>
      assert.rejects(() => mintStandaloneSession(), /AIVIN_APIKEY|aivin login/),
    ),
  );
});

test('mintStandaloneSession: POSTs to /plugins/sdk/session with the right auth headers/body and returns the minted session', async () => {
  const originalFetch = global.fetch;
  let capturedUrl: string | undefined;
  let capturedInit: any;
  global.fetch = (async (url: any, init: any) => {
    capturedUrl = String(url);
    capturedInit = init;
    return {
      ok: true,
      json: async () => ({ cap: 'cap-abc', client: 'acme', secret: 'secret-xyz' }),
    } as Response;
  }) as any;

  try {
    await withEnv({ AIVIN_APIKEY: 'acme-ak-realkey', AIVIN_BASE_URL: 'https://api.example.com' }, async () => {
      const session = await mintStandaloneSession({ workspaceId: 'ws1', pluginId: 'my-app' });
      assert.equal(session.client, 'acme');
      assert.equal(session.cap, 'cap-abc');
      assert.equal(session.workspaceId, 'ws1');

      assert.equal(capturedUrl, 'https://api.example.com/plugins/sdk/session');
      assert.equal(capturedInit.method, 'POST');
      assert.equal(capturedInit.headers.Authorization, 'Bearer acme-ak-realkey');
      assert.equal(capturedInit.headers['x-client-slug'], 'acme');
      const body = JSON.parse(capturedInit.body);
      assert.equal(body.plugin_id, 'my-app');
      assert.equal(body.workspace_id, 'ws1');
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('mintStandaloneSession: surfaces a non-ok response as a thrown error', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => ({
    ok: false,
    status: 401,
    text: async () => 'invalid api key',
  })) as any;

  try {
    await withEnv({ AIVIN_APIKEY: 'acme-ak-badkey', AIVIN_BASE_URL: 'https://api.example.com' }, () =>
      assert.rejects(() => mintStandaloneSession(), /HTTP 401/),
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('connectStandalone: binds a real SDKClient as the ambient invocation for the duration of fn', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => ({
    ok: true,
    json: async () => ({ cap: 'cap-abc', client: 'acme', secret: 'secret-xyz' }),
  })) as any;

  try {
    await withEnv({ AIVIN_APIKEY: 'acme-ak-realkey', AIVIN_BASE_URL: 'https://api.example.com' }, async () => {
      const result = await connectStandalone(async () => {
        const sdk = getCurrentSDK();
        assert.ok(sdk, 'ambient SDKClient should be bound inside connectStandalone');
        return 'ran-inside';
      }, { workspaceId: 'ws1' });
      assert.equal(result, 'ran-inside');
    });

    // Outside connectStandalone's fn, the ambient binding is gone again.
    assert.throws(() => getCurrentSDK(), /only usable while main\(\) is running/);
  } finally {
    global.fetch = originalFetch;
  }
});
