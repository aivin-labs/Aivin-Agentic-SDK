# 🏗️ SDK Architecture

This is internals documentation for people working on the SDK itself (or curious plugin authors).
You do not need any of this to write a plugin — see the [README](../README.md) and
[SDK reference](./SDK.md) for that. If you just want the mental model of how your plugin runs on
the platform, the next section is for you; everything after it is SDK internals.

## The big picture: how your plugin talks to the platform

Your plugin is not a library the platform links against — it is a **separate service** in its own
Docker container, and everything between it and the platform travels over one gRPC protocol in two
directions:

```
                         Aivin Platform (host)
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   AI Staff agent (planner)                                       │
│     · reads every manifest.json in the workspace                 │
│     · picks your plugin, maps its data onto your `input` schema  │
│           │                                                      │
│           ▼                                                      │
│   Plugin host ◄──────────► Backend services                      │
│     │       ▲              (LLM, embeddings, vector search,      │
│     │       │               store/redis/mongo, tasks, files,     │
│     │       │               realtime, notifications, ...)        │
└─────┼───────┼────────────────────────────────────────────────────┘
      │       │
  (1) │       │ (2)
Invoke│       │Invoke
      │       │  SDK calls — "ai.prompt",
      │       │  "store.set", "task.create", ...
      ▼       │
┌──────────────────────────────────────────────┐
│   Your plugin container                      │
│                                              │
│   PluginServer (gRPC server on :50051)       │
│     └─ loads src/main.ts                     │
│         └─ main(mission, input, ctx)         │
│             └─ imported SDK namespaces       │
│                 └─ GrpcInvoker (gRPC client) │
└──────────────────────────────────────────────┘
```

- **(1) Host → plugin** — the host calls `Invoke` on the gRPC server the SDK runs inside your
  container (`PluginServer`) to execute your `main()`. Your code never opens a port or registers a
  route; the SDK did that before your code was even loaded.
- **(2) Plugin → host** — every `ai.prompt(...)`, `store.set(...)`, `task.create(...)` your handler
  makes is an outbound `Invoke` back to the host, which executes it against the real backend
  services **on the host side** and returns just the result. Your container never holds a database
  connection, an LLM API key, or any other backend credential.

So from your plugin's point of view, the whole platform is one function —
`Invoke(namespace, params, context)` — and from the platform's point of view, your plugin is too.

### Life of an invocation

What actually happens, end to end, when an AI Staff agent uses your plugin:

1. **Trigger.** Something kicks off a run — a chat request, a schedule, a webhook, an event, or a
   direct API call (whatever `trigger_type` allows). The agent's planner selects your plugin from
   its `manifest.json` signals (`selection_rules`, `description`, `capabilities`, ...) and maps the
   data it has onto your declared `input` fields.
2. **The host calls your container.** It mints a short-lived, per-invocation **capability token**,
   then sends `Invoke` to `PluginServer` on `:50051` with:
   - `namespace` — the human-readable *mission* (why this run was triggered), not a function name;
   - `params_json` — your `input`, matching the manifest's `input` schema;
   - `context_json` — the invocation identity (`user`, `workspace`, `session`, per-workspace
     `config`, ...) plus the capability token in `metadata._cap`.
3. **The SDK dispatches to your code.** `PluginServer` parses the request, resolves the entry point
   (your `main` export — or for multi-function plugins, the `func` the host named), builds `ctx`
   with a ready-to-use `SDKClient` bound to this invocation's identity, and calls
   `main(mission, input, ctx)`.
4. **Your code calls back out.** Every SDK call your handler makes during the run — via an
   imported namespace, or legacy `ctx.sdk`, same thing — travels as an outbound `Invoke` with a dotted
   `namespace` (`"ai.prompt"`, `"vector.search"`, ...), your params, and the echoed capability
   token. The host resolves *which tenant/workspace this really is* from that token server-side,
   scopes the operation accordingly, and returns the result. (Streaming responses use the
   `InvokeStream` variant — see [Transport](#transport-one-proto-two-directions).)
5. **You return, the agent continues.** Your `PluginResponse` is JSON-serialized into `data_json`
   (capped at 1MB) and handed back to the host. The planner reads it against your manifest's
   `output` shape — auditing whether the step succeeded, mapping `data` into a later stage's
   input, or replanning on failure.

Two properties of this design worth internalizing:

- **Discovery is data, not code.** There is no route table or tool-schema registration anywhere in
  this flow — step 1 works purely off `manifest.json`. Improving how agents use your plugin means
  editing the manifest, not the transport.
- **The protocol never grows.** Both directions are the same generic `Invoke` RPC, so new platform
  capabilities appear as new `namespace` strings — your deployed plugin's transport never needs a
  rebuild to coexist with them.

During local development (`aivin start`) the only thing that changes is who plays the host: there
is no planner and no inbound gRPC caller, so `LocalTestServer` gives you a `curl`-able
`POST /invoke` that feeds the same pipeline from step 3 onward — while your outbound SDK
calls still go to a real backend. See
[Local testing without a host](#local-testing-without-a-host).

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
│   │   └── GrpcInvoker.ts  # Outbound Invoke() call — what every SDK call uses under the hood
│   ├── sdk/
│   │   └── SDKClient.ts    # Full SDK client (mirrors the backend's CodeSDK.d.ts)
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

- **Plugin → host** (outbound SDK calls): `GrpcInvoker.invokeHost()` connects to
  `SDK_ENDPOINT` (injected by the host container runtime, typically
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

Every `Invoke` call carries `Authorization: Bearer <SDK_SECRET>` in gRPC metadata (both
directions) — a shared secret injected into your container's environment at deploy time.

That alone isn't enough to establish _which tenant/workspace_ an outbound SDK call belongs
to: your plugin's own code runs in the same OS process as the SDK client, so it could otherwise claim to
be any tenant. To prevent that, the host mints a random, short-lived **capability token** for every
inbound trigger, threads it through `context.metadata._cap` on the way in, and `SDKClient` echoes
that same token on every outbound SDK call your handler makes during that invocation. The
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
calls `PluginServer.testInvoke()` directly (in-process, no gRPC round trip). SDK calls
still work for real either way - against production by default, or against a local/dev backend if
you set `SDK_ENDPOINT`/`SDK_SECRET` yourself.
