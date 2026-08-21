# 🧩 `plugin` — call and discover other plugins

The `plugin` namespace is how a plugin reaches *other* plugins: trigger one by id (with its own
mission/arguments), fetch its manifest, semantically search the plugin store for candidates, or
let the platform pick the single best-fitting plugin for a described task. Reach for it whenever
your plugin needs to delegate specialized work to another plugin instead of reimplementing that
logic itself.

## Import

```typescript
import { plugin } from '@aivin-labs/sdk';
```

`plugin` is a hand-written export, not backed by `bindNamespace()` like the other namespaces in
this SDK — `SDKClient` already has an unrelated `@internal` field also named `plugin`
(plugin-marketplace catalog ops, gated to a privileged internal caller, not reachable from a
regular plugin). This export is a separate object entirely, so there's no collision; it just isn't
generated the same mechanical way the rest of the namespaces are.

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `trigger` | `pluginId: string, mission: string, params?: Record<string, any>, opts?: { workspaceId?: string; agentId?: string; sessionId?: string; timeoutMs?: number; signal?: AbortSignal }` | `Promise<T>` | Executes another plugin by id. `mission` and `params` are separate arguments — never concatenated into `pluginId` — so it works correctly for ids that themselves contain dots (`official.xxx`, `analyst.xxx`, the vast majority of real ids). |
| `info` | `pluginId: string` | `Promise<PluginManifest \| null>` | Fetches one plugin's manifest (name, description, input/output schema). `null` if it doesn't exist or isn't visible to this tenant. |
| `search` | `query: string, opts?: { limit?: number; threshold?: number }` | `Promise<PluginManifest[]>` | Semantic search over the plugin store (this tenant's installed plugins + the public global store), ranked by relevance. |
| `fit` | `query: string, opts?: { allowedPluginIds?: string[] }` | `Promise<PluginManifest \| null>` | Picks the single best-fitting plugin for a described task, or `null` if nothing clears the confidence bar — the same selection logic the platform's own agent uses to decide whether a request should route to a plugin at all. |
| `infoBatch` | `pluginIds: string[]` | `Promise<PluginManifest[]>` | Fetches several manifests at once - saves N round trips vs calling `info()` in a loop. Ids that don't exist or aren't visible are simply omitted from the result, not `null` placeholders. |
| `status` | `pluginId: string` | `Promise<{ allowed: boolean; state: 'closed' \| 'open' }>` | Checks the plugin's circuit-breaker state without triggering it - `state: 'open'` means recent failures tripped the breaker and `allowed` is `false` until it resets. Check before `trigger()` if you want to fail fast/fall back instead of waiting on a plugin already known to be failing. |

## `trigger` example

```typescript
import { plugin } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const audit = await plugin.trigger(
    'official.comprehensive_audit',
    'Audit the report for compliance',
    { content: input.text, audit_scope: ['finance'] },
  );
  return { status: 'success', data: audit };
}
```

By default the target plugin runs in the same workspace/agent/session as the caller (ambient, same
identity `call()` uses). `opts` redirects a specific invocation elsewhere:

```typescript
const result = await plugin.trigger(
  'official.task_report',
  'Weekly report for Marketing',
  { period: 'weekly' },
  { workspaceId: 'ws_marketing', agentId: 'agent_reporting_bot' },
);
```

`opts.workspaceId` doesn't just get trusted — the host re-verifies the *caller's real identity*
(from the cap token, not this field) has admin access to that workspace before running anything.
Passing a workspace you don't have access to fails; it does not silently impersonate.

## `search` + `fit` + `trigger` together

```typescript
import { plugin } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const best = await plugin.fit(input.task_description);
  if (!best) {
    return { status: 'error', message: 'No plugin fits this task' };
  }
  const result = await plugin.trigger(best.id, mission, input.task_data);
  return { status: 'success', data: result };
}
```

`search`/`fit` take a moment to run (embeddings + vector search) — skip them and call
`plugin.trigger()` directly when you already know the target plugin id.

## `status` example

```typescript
import { plugin } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const health = await plugin.status('official.comprehensive_audit');
  if (!health.allowed) {
    return { status: 'error', message: 'Target plugin is currently unavailable (circuit open)' };
  }
  const result = await plugin.trigger('official.comprehensive_audit', mission, input);
  return { status: 'success', data: result };
}
```

## Notes & caveats

- Do **not** use the generic `call('pluginId.purpose', params)` escape hatch to invoke another
  plugin — `call()`'s `namespace` argument splits on the *first* dot, which silently targets the
  wrong plugin for any id that itself contains one. `call()` stays reserved for host namespaces
  (`ai.*`, `table.*`, ...), which never contain dots in the id portion.
- `info`/`search`/`fit` are read-only — no execution, no side effects. Tenant scoping (which
  plugins are visible) is always resolved from the caller's own identity server-side; there's no
  `client`/`tenant` field to pass.
- `trigger`'s `opts.sessionId` only has an effect together with `opts.agentId` — reusing a session
  without an agent isn't meaningful (a session belongs to an agent in this data model).
- There is no `plugin.cancel(...)` - the platform has no cancellation mechanism for an in-flight
  `trigger()` call (unlike `ai.cancel(requestId)` for `ai.prompt()`). Don't invent one; if you need
  to bound how long you wait, use `opts.timeoutMs`/`opts.signal` on `trigger()` instead.

## See also

- [SDK Reference](../SDK.md#calling-another-plugin---plugintrigger) — the full SDK surface
- [Changelog](../CHANGELOG.md) — when `plugin.*` was added and why
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
