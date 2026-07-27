# 🏗️ SDK Architecture

This is internals documentation for people working on the SDK itself (or curious plugin authors).
You do not need any of this to write a plugin — see the [README](../README.md) and
[SDK reference](./SDK.md) for that.

## Directory layout

```
sdk/
├── bin/
│   ├── cli.mjs             # `aivin` CLI: create / plugin make / validate / start / test / deploy / login
│   └── server.mjs          # `aivin start` entry point — boots PluginServer (+ LocalTestServer in dev)
├── src/
│   ├── index.ts            # Package entry point
│   ├── PluginServer.ts     # gRPC server the host calls into to run main()
│   ├── LocalTestServer.ts  # Dependency-free HTTP shim wrapping PluginServer.testInvoke() for `curl`
│   ├── grpc/
│   │   ├── loadProto.ts    # Shared proto loader (client + server use the same generated service)
│   │   └── GrpcInvoker.ts  # Outbound Invoke() call — what ctx.sdk.call() uses under the hood
│   ├── sdk/
│   │   └── SDKClient.ts    # Full ctx.sdk implementation (mirrors the backend's CodeSDK.d.ts)
│   ├── types/
│   │   ├── PluginTypes.ts  # PluginManifest (mirrors backend DeveloperPluginManifest), TriggerType
│   │   └── SDKTypes.ts     # User, Workspace, Task, Agent, PluginResponse, ...
│   └── proto/
│       └── sdk_transport.proto  # Byte-for-byte copy of the backend's proto - see below
└── docs/
```

## Transport: one proto, two directions

The platform's plugin transport is a single generic gRPC RPC, defined in
`src/proto/sdk_transport.proto`:

```protobuf
service SdkTransportService {
  rpc Invoke (SdkInvokeRequest) returns (SdkInvokeResponse);
}
message SdkInvokeRequest  { string namespace = 1; string params_json = 2; string context_json = 3; }
message SdkInvokeResponse { bool success = 1; string data_json = 2; string error = 3; }
```

The _same_ `Invoke` RPC is used both ways:

- **Plugin → host** (`ctx.sdk.*` calls): `GrpcInvoker.invokeHost()` connects to
  `SDK_GRPC_ENDPOINT` (injected by the host container runtime, typically
  `host.docker.internal:50051`; falls back to the production endpoint `api.aivin.cloud:50051` with
  TLS when unset, so local `aivin start` testing works without any config) and sends
  `namespace = "ai.prompt"` etc. Connections to anything other than a local/loopback/
  container-internal address use TLS by default (override with `SDK_GRPC_TLS=true|false`).
- **Host → plugin** (running your `main()`): `PluginServer` runs a gRPC server on `0.0.0.0:50051`
  inside your container. The host calls `Invoke` with `namespace` set to the human-readable
  _purpose_ of the trigger (not a function name — the server always resolves to your single
  `main` entry point, then a default export, then the first exported function, in that order).

This symmetry means adding a new backend capability never requires a proto change — just a new
`namespace` string registered on the host side.

## Auth: shared secret + per-invocation capability

Every `Invoke` call carries `Authorization: Bearer <SDK_GRPC_SECRET>` in gRPC metadata (both
directions) — a shared secret injected into your container's environment at deploy time.

That alone isn't enough to establish _which tenant/workspace_ an outbound `ctx.sdk.*` call belongs
to: your plugin's own code runs in the same OS process as `ctx.sdk`, so it could otherwise claim to
be any tenant. To prevent that, the host mints a random, short-lived **capability token** for every
inbound trigger, threads it through `context.metadata._cap` on the way in, and `SDKClient` echoes
that same token on every outbound `ctx.sdk.*` call your handler makes during that invocation. The
host resolves your real identity from that token server-side — never from anything your process
claims about itself.

## Why erasable-only TypeScript in `src/main.ts`

`PluginServer.loadPlugin()` loads `src/main.ts` via a real dynamic `import()` (routed through
`new Function('specifier', 'return import(specifier)')` so TypeScript's CommonJS-target downlevel
of `import()` — which would otherwise resolve to a `require()`-based helper that can't load a
native ESM/TS file — doesn't kick in). This relies on Node's native TypeScript support
(stable from Node 22.6, default from Node 24), which only accepts _erasable_ syntax: no `enum`, no
`namespace` with runtime code, no parameter properties. That's why `TriggerType` in
`PluginTypes.ts` is a `const` object + union type instead of a TS `enum`.

## Local testing without a host

`aivin start` always boots the real `PluginServer` gRPC server. In development it additionally
starts `LocalTestServer` — a plain `http` server (no framework) exposing `POST /invoke`, which
calls `PluginServer.testInvoke()` directly (in-process, no gRPC round trip). `ctx.sdk.*` calls
still work for real either way - against production by default, or against a local/dev backend if
you set `SDK_GRPC_ENDPOINT`/`SDK_GRPC_SECRET` yourself.
