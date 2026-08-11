# Security: how a container/caller proves who it is

This is internals documentation for people working on the SDK itself (or the backend it talks to).
If you're just writing a plugin, you don't need this — `SDK_ENDPOINT`/auth are injected into your
container automatically, you never touch them. This doc is for anyone changing `GrpcInvoker.ts`,
`GrpcSDKServer.ts` (backend), or debugging an auth failure that isn't self-explanatory.

## The three credentials, and why there are three

| Credential | Proves | Lifetime | Mechanism | Early revocation |
|---|---|---|---|---|
| `cap` | *which tenant/workspace/session* this one call belongs to | seconds–minutes | HMAC-SHA256, stateless, verified locally (`GrpcCapabilityStore`) | Not needed — TTL is short enough that waiting it out is cheaper than a revocation path |
| `secret` | *this caller is a container the host actually spawned* | container lifetime (minutes–hours) | Random value, Redis-backed (`GrpcContainerSecretStore`) | Yes, instant — container teardown revokes it |
| `api_key` | *this is you*, for `aivin login`/CLI/test-only endpoints | weeks–months | Redis/Mongo-backed | Yes, instant (`aivin key revoke`) |

Three different lifetimes, three different mechanisms — not an inconsistency. A short-TTL,
high-frequency check (`cap` runs on *every* `ctx.sdk.*` call) is cheapest as a stateless signature;
a long-lived, human-facing credential (`api_key`) needs instant revocation badly enough to be worth
a DB round-trip. `secret` sits in between.

`cap` and `secret` answer two genuinely different questions and neither can substitute for the
other:

- `secret` alone says "a real container" — but not *which* tenant. Before `cap` existed,
  `GrpcSDKServer` trusted the tenant identity a container claimed about itself in `context_json`,
  which a community plugin's own code (running in the same OS process as the SDK client, no
  isolation between the two) could set to any value — including another tenant's `client` id.
- `cap` alone says "this tenant" — but not "from a container the host actually spawned". Without
  `secret`, anyone who ever captured a `cap` (log line, error message, ...) could replay it
  directly against the public gRPC endpoint (`sdk.aivin.cloud:443`) with no need to have ever run a
  real container.

Both are required on every `Invoke`/`InvokeStream` call — see
`GrpcSDKServer.authenticateAndResolveContext` on the backend.

## What this does *not* protect against

Worth being explicit about, because it's easy to assume more than is actually true:

**A malicious plugin cannot be stopped from acting as its own tenant.** Its own code shares the
same OS process as the SDK client, so it can always read whatever credential material
(`secret`, and — once wired up — a client cert) the SDK is using, the same way it can read its own
`cap`. Nothing here defends against that; `cap`'s job is to make sure that plugin *stays confined to
its own tenant* even if it does exactly this, not to hide the credential from the plugin itself. No
software-only mechanism running in the plugin's own process can hide a secret from that same
process — see [Future direction](#future-direction-a-credential-holding-sidecar) below for the one
architecture that actually would.

**Both `cap` and `secret` are bearer credentials.** Whoever holds the string can use it, from
anywhere, until it expires — this is standard for essentially all HTTP/gRPC API auth, not a
weakness specific to this system. Switching the `secret` layer to mTLS (see below) doesn't change
this either: a client cert's private key sitting in a container's filesystem is exactly as readable
by that container's own code as a bearer token file is.

## `configureTransport()` — endpoint/secret without `process.env`

`GrpcInvoker`'s default resolution (`resolveEndpoint()`/`resolveSdkSecret()`) reads
`SDK_ENDPOINT`/`SDK_SECRET_FILE`/`SDK_SECRET` from `process.env` — the right default for a real
deployed container, where the host (`DockerHelper`) injects these before your code ever runs and
your plugin never touches them directly.

A caller that mints its own per-invocation identity at runtime instead of running inside a real
container (e.g. a test harness driving a `mint-cap`-style endpoint) can call
`configureTransport({ endpoint, secret })` to hand the SDK these values directly as plain JS values,
bypassing `process.env` entirely:

```typescript
import { configureTransport } from '@aivin-labs/sdk';

const { cap, client, secret } = await mintMyOwnCap(...);
configureTransport({ endpoint: sdkEndpoint, secret });
// subsequent sdk.* calls use these values, no process.env involved
```

Env/file resolution stays exactly as-is for real containers — this is additive, not a replacement.
`configureTransport()` clears the cached gRPC client/secret so the new values take effect on the
very next call even if something already called the SDK earlier in this process. See
`GrpcInvoker.ts`'s `explicitTransportConfig`.

## `configureMtls()` — prototype, not live security yet

`configureMtls({ certDir })` (or `{ ca, cert, key }` directly) makes the gRPC channel present a
client certificate on the TLS handshake, read from `ca.pem`/`client.crt`/`client.key` in a local
directory — deliberately the same one-directory-per-machine shape as `~/.aivin/credentials`, so
`aivin login` could someday write these the same way.

**This is API-shape-only right now.** `GrpcSDKServer.buildServerCredentials` (backend) only
*terminates* TLS with a server cert; it demands a client cert back only when `SDK_GRPC_TLS_CA` is
configured, and even then doesn't resolve a caller *identity* from it — it never replaces the
`secret` check. A call made with `configureMtls()` set still needs a valid `secret`+`cap` to
authenticate, exactly as if it hadn't been called at all. Don't rely on this for anything until the
backend side is built out.

## Future direction: a credential-holding sidecar

The one architecture that would actually stop a malicious plugin from exfiltrating its own raw
credential (for later out-of-band replay, outside the container's own lifetime) is moving the
credential out of the plugin's process entirely: a small sidecar process, in the same container but
a **separate OS process**, holds `secret`/cert material and is the only thing that actually dials
the host. The plugin's SDK calls go to the sidecar over a local socket instead of directly to the
host; the sidecar attaches the real credential and forwards the call.

This does **not** grant the plugin any new capability — `cap` already confines it to its own tenant
either way, sidecar or not. What it buys is narrower: the plugin can use its access, but can no
longer walk away with the raw bearer material itself. That's a real engineering project (process
supervision inside the container image, a local IPC protocol, sidecar lifecycle tied to the
container's), not something to take on incidentally — noted here so it isn't re-derived from
scratch if it becomes worth doing later.

## `LocalTestServer`'s `/invoke` — loopback-only, no auth

`aivin start`'s local HTTP test shim (`src/LocalTestServer.ts`) has no auth on `POST /invoke` by
design — it's meant to be driven by `curl`/scripts on your own machine. The caller freely picks
`ctx`, including `ctx.metadata._cap` — the capability token used for any `ctx.sdk.*` call the
invocation makes. If `SDK_ENDPOINT`/`SDK_SECRET` are pointed at a real backend while this is
running (the normal case for local dev), an unauthenticated caller reaching this port could pick
any tenant/workspace via `ctx` and have it backed by this container's real `secret`.

Two independent mitigations, neither of which requires trusting the caller's `ctx`:

- **Bound to `127.0.0.1` by default** (`LocalTestServerConfig.host`, `LOCAL_TEST_HOST` env var for
  `aivin start`) — not `0.0.0.0`. Closes off anyone else on the same network.
- **Cross-origin requests are rejected** even from `127.0.0.1` (`isAllowedOrigin`) — loopback
  binding alone doesn't stop a malicious webpage open in the developer's own browser from doing
  `fetch('http://localhost:4001/invoke', ...)`; the browser making that request is already "local."
  A request with no `Origin` header (curl, node scripts) is unaffected.

Widening `host` past loopback is a deliberate, logged opt-in (`LOCAL_TEST_HOST=0.0.0.0`), not a
default — only do it on a network you trust.

## Where to look

- `src/grpc/GrpcInvoker.ts` — outbound call, `resolveEndpoint`/`resolveSdkSecret`,
  `configureTransport`/`configureMtls`.
- `src/LocalTestServer.ts` — the unauthenticated local dev HTTP shim, see above.
- Backend: `src/base/sdk/GrpcCapabilityStore.ts` (`cap`), `src/base/sdk/GrpcContainerSecretStore.ts`
  (`secret`), `src/base/sdk/GrpcSDKServer.ts` (`authenticateAndResolveContext` — where both are
  actually checked).
