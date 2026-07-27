# 📁 `project` — read-only project lookup

The `project` namespace is a small, read-only surface for looking up projects: fetch one by ID, or
search projects in a workspace by keyword. There is no `create`/`update`/`delete` here — project
lifecycle management is not exposed to plugins through this namespace.

## Import

```typescript
import { project } from '@aivin/sdk';
// equally: ctx.sdk.project / import SDK from '@aivin/sdk'; SDK.project
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `get` | `params: { id: string }` | `Promise<any>` | Fetch a single project by ID. |
| `search` | `params: { workspace_id?: string; keyword?: string }` | `Promise<any[]>` | Search projects, optionally scoped to a workspace and/or filtered by keyword. |

Note: unlike most other namespaces' `get`, `project.get` takes an **object** (`{ id }`), not a bare
string — match the exact shape shown above.

## `get` example

```typescript
import { project } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  const proj = await project.get({ id: input.projectId });
  return { status: 'success', data: proj };
}
```

## `search` example

```typescript
import { project } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  const matches = await project.search({
    workspace_id: ctx.workspace.id,
    keyword: 'onboarding',
  });
  return { status: 'success', data: matches };
}
```

Both `workspace_id` and `keyword` are optional — omitting `workspace_id` searches across whatever
scope the backend defaults to for the caller's identity; omitting `keyword` returns an unfiltered
list (subject to whatever default limit the backend applies).

## Notes & caveats

- This is intentionally a thin, read-only namespace — `SDKClient.ts` defines only `get`/`search`
  for `project`, with no accompanying comment flagging additional unconfirmed methods. Don't assume
  `create`/`update`/`delete` exist here; if you need project mutation, it isn't part of this
  namespace's confirmed surface.
- Return types are untyped (`Promise<any>` / `Promise<any[]>`) in `SDKClient.ts` — there is no
  dedicated `Project` interface in `SDKTypes.ts` to reference for exact field names. Treat the
  shape as whatever the backend's `project.getProject`/`project.searchProject` handlers return and
  inspect at runtime if you need specific fields.
- The two datastore-related namespaces (`ctx.sdk.datastore`, project-scoped tables/rows) are a
  separate, much larger surface — don't confuse `project.search` (finds project records) with
  `datastore.getRows`/`getTables` (queries data *within* a project's tables).

## See also

- [SDK Reference](../SDK.md) — the full `ctx.sdk` surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
