# 🪪 Plugin Context (`ctx`)

`ctx` is the 3rd argument to your handler — `main(mission, input, ctx)` — and is the **runtime
identity of one invocation**: who triggered this run, in which workspace, with what credentials
and configuration. A fresh `ctx` is built for every invocation from the context the host sends
over gRPC (`PluginServer.handleInvoke`); nothing in it persists between runs.

```typescript
interface PluginContext {
  sdk: SDKClient; // the full platform surface — see docs/SDK.md
  user?: User; // who triggered this run
  workspace?: Workspace; // where it runs
  session?: MessageSession; // the chat session, when run from a conversation
  org_id?: string; // owning organization
  client?: string; // calling client/host (e.g. "aivin.cloud")
  config?: Record<string, any>; // per-workspace plugin configuration
  cert?: ConnectionInfo; // connected-account credentials, if manifest.connection_id is set
  metadata?: Record<string, any>; // free-form extras from the host
}
```

It mirrors the backend's `PluginContext` (`CodeSDK.d.ts`), plus `cert`.

## Fields

| Field       | Type                  | Present when                                        | Description                                                                                                                                                                                                                        |
| ----------- | --------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk`       | `SDKClient`           | always                                              | **Legacy** handle to the platform client (`ai`, `mongo`, `file`, `queue`, ...) bound to **this** invocation's tenant and capability token. Prefer importing from `@aivin-labs/sdk` instead — see [Reaching the SDK](#reaching-the-sdk-imports-with-ctxsdk-as-legacy) below. |
| `user`      | `User`                | a real user is behind the run                       | Who triggered this run — `id`, `name`, `email`, `lang`, ... See [DATA_STRUCTURES.md](./DATA_STRUCTURES.md#user).                                                                                                                    |
| `workspace` | `Workspace`           | run belongs to a workspace (virtually always)       | Where the run happens — `id`, `name`, `members` (with roles), ... See [DATA_STRUCTURES.md](./DATA_STRUCTURES.md#workspace).                                                                                                         |
| `session`   | `MessageSession`      | invoked from a chat/agent conversation              | The conversation this run is part of — `id`, `thread_id`, `agent_id`, ... See [DATA_STRUCTURES.md](./DATA_STRUCTURES.md#messagesession). Absent for schedule/api/webhook-style triggers.                                            |
| `org_id`    | `string`              | workspace belongs to an organization                | Owning organization id.                                                                                                                                                                                                             |
| `client`    | `string`              | always in practice                                  | Which client/host issued the call (e.g. `"aivin.cloud"`).                                                                                                                                                                          |
| `config`    | `Record<string, any>` | the plugin has configuration                        | This plugin's own configuration stored in the workspace. Values the user set up via `manifest.initable` land here — unless the plugin has a `connection_id`, in which case they're stored as a connection and surface as `ctx.cert` instead. (`manifest.initial` defaults are merged into `input`, not here.) See [MANIFEST.md](./MANIFEST.md#fields). |
| `cert`      | `ConnectionInfo`      | `manifest.connection_id` is set and user connected  | Connected-account credentials for the external service: `token`, `provider`, `name`, plus provider-specific extras. See [DATA_STRUCTURES.md](./DATA_STRUCTURES.md#connectioninfo-available-as-ctxcert-when-manifestconnection_id-is-set). |
| `metadata`  | `Record<string, any>` | host attaches extras                                | Free-form invocation extras. Also carries host-internal keys — `_cap` (the capability token threaded into outbound `sdk` calls) and `func` (multi-function routing, see [MANIFEST.md](./MANIFEST.md#multi-function-plugins)) — treat those as reserved, don't rely on or modify them. |

Everything except `sdk` is optional — always guard (`ctx.user?.id`) rather than assume, especially
for `session` (absent outside chat) and `cert` (absent until the user connects an account; return
`PluginStatus.NEEDS_AUTH` in that case).

## Reaching the SDK: imports (with `ctx.sdk` as legacy)

Import just the namespace(s) you need — this is the way to call the platform:

```typescript
import { mongo } from '@aivin-labs/sdk';
mongo.model('users').find({ ... });
```

The imports are proxies that resolve the current invocation's `SDKClient` on every access
(`AsyncLocalStorage` under the hood), so they're safe under concurrent invocations in one
container — and they save you threading `ctx` through your own helper functions. The SDK is
designed so your logic doesn't have to depend on `ctx` at all.

`ctx.sdk` (the same client, handed in as `main()`'s 3rd argument) is the **legacy** mechanism —
still supported, not recommended for new code. Its one remaining niche: the imports throw when
accessed **outside a running `main()`** (e.g. at module top level), so code that runs there needs
the `ctx.sdk` reference passed to it explicitly. See [SDK.md](./SDK.md#calling-the-sdk).

## Typical usage

```typescript
import { ai, mongo } from '@aivin-labs/sdk';
import { PluginStatus } from '@aivin-labs/sdk';
import type { PluginInput, PluginContext, PluginResponse } from '@aivin-labs/sdk';

export async function main(
  mission: string,
  input: PluginInput,
  ctx: PluginContext,
): Promise<PluginResponse> {
  // Who/where — personalize and scope by the invocation identity
  const greetingLang = ctx.user?.lang ?? ctx.workspace?.lang ?? 'en';

  // Connected account — bail out cleanly if not linked yet
  if (!ctx.cert?.token) {
    return { status: PluginStatus.NEEDS_AUTH, message: 'Please connect your account first.' };
  }
  const res = await fetch('https://api.example.com/me', {
    headers: { Authorization: `Bearer ${ctx.cert.token}` },
  });

  // Per-workspace plugin configuration (e.g. values set up via manifest `initable`)
  const region = ctx.config?.region ?? 'us-east-1';

  const summary = await ai.prompt(`Summarize for a ${greetingLang} reader: ${input.text}`);
  return { status: PluginStatus.SUCCESS, data: { summary, region } };
}
```

## Local testing (`aivin start`)

Locally there is no host to mint a real identity, so `ctx.user`/`ctx.workspace`/`ctx.session` are
whatever your test request supplies (usually absent) — write your handler to tolerate that.
SDK calls still work if `SDK_ENDPOINT`/`SDK_SECRET` point at a real backend (they
default to production `api.aivin.cloud` — see
[PLUGIN_DEVELOPMENT_GUIDE.md#local-runtime-behavior](./PLUGIN_DEVELOPMENT_GUIDE.md#local-runtime-behavior));
otherwise any SDK call throws a clear "not set" error.

## Related

- **[SDK Reference](./SDK.md)** — everything the SDK imports can call
- **[Data Structures](./DATA_STRUCTURES.md)** — full `User`, `Workspace`, `MessageSession`,
  `ConnectionInfo` shapes
- **[Manifest Reference](./MANIFEST.md)** — `connection_id`, `initable`/`initial`, and the other
  fields that shape what arrives in `ctx`
- **[Plugin Development Guide](./PLUGIN_DEVELOPMENT_GUIDE.md)** — `ctx` in the context of writing
  and testing a handler
- **[`@aivin-labs/cli` Getting Started guide](https://github.com/aivin-labs/cli/blob/main/docs/GETTING_STARTED.md)** — scaffolding, running locally, deploying
