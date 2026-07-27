# 🏢 `workspace` — read workspace details, members, permissions, and agent search

The `workspace` namespace is how a plugin looks up information about the tenant it's running
inside: the workspace record itself, its member list, permission checks for a given user, this
plugin's saved per-workspace config, and semantic search over the workspace's AI Staff agents
(used internally by `agent.delegate`/`a2a()` to resolve a free-text target into an agent ID).
Reach for it whenever your plugin needs to know *who's in this workspace* or *whether the caller is
allowed to do something*, rather than operating on tasks/projects/messages themselves.

## Import

```typescript
import { workspace } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.workspace
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `get` | `id: string` | `Promise<Workspace>` | Full workspace details for a single workspace ID. |
| `getByIds` | `ids: string[]` | `Promise<Workspace[]>` | Full details for multiple workspaces at once. |
| `getMembers` | _(none)_ | `Promise<string[]>` | Member list for the current workspace (resolved server-side from the caller's identity). |
| `checkPermission` | `params: { workspace_id?: string; user_id?: string; permission: string }` | `Promise<boolean>` | Checks whether a member has a given permission. |
| `getPluginConfig` | `params: { plugin_id: string; workspace_id?: string }` | `Promise<any>` | Reads this (or another) plugin's saved per-workspace config. |
| `updatePlugin` | `params: { plugin_id: string; workspace_id?: string; arguments: Record<string, any> }` | `Promise<any>` | Writes arguments for a plugin already installed in the workspace. Requires the caller to have admin permission (enforced server-side inside the handler). |
| `searchAgents` | `params: { query: string; limit?: number; threshold?: number }` | `Promise<Agent[]>` | Semantic search for an AI Staff agent by description. Also used internally by `a2a()`/`agent.delegate()` to resolve a non-ID target string. |

`Workspace` shape (from `SDKTypes.ts`):

```typescript
interface Workspace {
  id: string;
  name: string;
  key: string;
  client: string;
  avatar?: string;
  creator_uid: string;
  lang?: string;
  members: Array<{
    user_id: string;
    name: string;
    email: string;
    role: 'owner' | 'admin' | 'member' | 'observer';
  }>;
}
```

## `get` example

```typescript
import { workspace } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const ws = await workspace.get(ctx.workspace.id);
  return { status: 'success', data: { name: ws.name, memberCount: ws.members.length } };
}
```

## `checkPermission` example

```typescript
import { workspace } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const allowed = await workspace.checkPermission({
    user_id: ctx.user?.id,
    permission: 'billing.manage',
  });
  if (!allowed) {
    return { status: 'error', message: 'Caller lacks billing.manage permission' };
  }
  // ... proceed
  return { status: 'success' };
}
```

`workspace_id`/`user_id` are optional on `checkPermission` — omit them to default to the current
invocation's workspace/user (resolved server-side from `ctx`), and pass them explicitly only when
checking a different workspace or a different member than the caller.

## `searchAgents` example

```typescript
import { workspace } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const matches = await workspace.searchAgents({ query: 'customer support triage', limit: 3 });
  return { status: 'success', data: matches };
}
```

## `getPluginConfig` example

```typescript
import { workspace } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const cfg = await workspace.getPluginConfig({ plugin_id: 'my-plugin-id' });
  return { status: 'success', data: cfg };
}
```

## Notes & caveats

- `workspace.searchAgents` is not just a convenience method for callers — it's the exact mechanism
  `a2a()`/`agent.delegate()` use internally to resolve a free-text `target` string into a real
  agent ID before delegating. If you're building similar agent-resolution logic yourself, this is
  the confirmed real endpoint to use (`workspace.searchAgents` on the backend).
- All methods in this namespace map 1:1 to real backend RPCs (`workspace.getWorkspace`,
  `workspace.getWorkspacesByIds`, `workspace.getMembers`, `workspace.checkMemberPermission`,
  `workspace.getPluginConfig`, `workspace.updateWorkspacePlugin`, `workspace.searchAgents`) — none
  are flagged as unconfirmed in `SDKClient.ts`.
- `getMembers()` takes no parameters and always resolves against the *current* invocation's
  workspace — there is no `workspace_id` override for it (unlike `checkPermission`/`getByIds`).

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
