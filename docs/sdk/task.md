# ✅ `task` — create, read, update, delete, and list tasks

The `task` namespace is the SDK's CRUD surface over the platform's task tracker — create a task
assigned to someone, look one up by ID, update its status/content, delete it, or list tasks for a
workspace (optionally filtered by status/assignee) or for the current user specifically. Reach for
it whenever your plugin needs to turn a mission's output into trackable work items, or read/update
existing ones.

## Import

```typescript
import { task } from '@aivin/sdk';
// equally: ctx.sdk.task / import SDK from '@aivin/sdk'; SDK.task
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `create` | `params: { title: string; content?: string; assignee_id?: string; workspace_id: string; due_date?: string }` | `Promise<Task>` | Create a task. |
| `update` | `taskId: string, data: { status?: string; content?: string }` | `Promise<Task>` | Update a task by ID. `taskId` is a separate positional argument, not part of `data`. |
| `getById` | `taskId: string` | `Promise<Task>` | Fetch a single task by ID. |
| `list` | `params: { workspace_id: string; status?: string; assignee_id?: string; limit?: number }` | `Promise<Task[]>` | List tasks in a workspace, optionally filtered. |
| `delete` | `taskId: string` | `Promise<any>` | Delete a task by ID. |
| `listMine` | `params?: { status?: string; limit?: number; [key: string]: any }` | `Promise<Task[]>` | List tasks assigned to the current user. |

`Task` shape (from `SDKTypes.ts`):

```typescript
interface Task {
  id: string;
  title: string;
  content?: string;
  status: 'todo' | 'doing' | 'done' | 'backlog' | 'cancel';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  assignee_id?: string;
  workspace_id: string;
  due_date?: string;
}
```

## `create` example

```typescript
import { task } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  const newTask = await task.create({
    title: 'Follow up with customer',
    content: `Auto-created from run: ${mission}`,
    assignee_id: ctx.user?.id,
    workspace_id: ctx.workspace.id,
    due_date: '2026-08-01',
  });
  return { status: 'success', data: newTask };
}
```

## `update` example

```typescript
import { task } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  // taskId is passed separately - it is NOT a field inside `data`.
  const updated = await task.update(input.taskId, { status: 'done' });
  return { status: 'success', data: updated };
}
```

## `getById` / `delete` example

```typescript
import { task } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  const existing = await task.getById(input.taskId);
  if (existing.status === 'cancel') {
    await task.delete(input.taskId);
    return { status: 'success', message: 'Cancelled task removed' };
  }
  return { status: 'success', data: existing };
}
```

## `list` / `listMine` example

```typescript
import { task } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  const openTasks = await task.list({
    workspace_id: ctx.workspace.id,
    status: 'todo',
    limit: 50,
  });
  const mine = await task.listMine({ status: 'doing' });
  return { status: 'success', data: { openTasks, mine } };
}
```

## Notes & caveats

- **`update`/`getById`/`delete` were fixed to send `task_id`** (matching the real backend's
  `src/base/SDK.ts` `get task()`) — they previously sent `id`, which the real `task.updateTask`/
  `task.getTaskById`/`task.deleteTask` handlers don't read. Calls using the old shape were silently
  broken (the request would go through but not touch the intended task). This SDK's current
  implementation is correct; the caveat is here so you understand why `taskId` is threaded through
  as `task_id` on the wire even though the client-facing method signature takes it positionally.
- **`gen`, `addComment`, `requestSupport`** (present in the older `CodeSDK.d.ts` declarations) have
  **no confirmed real implementation** on the backend and have been removed from this SDK rather
  than risk shipping a wrong param shape. If you need equivalent behavior, use the generic
  `call('task.<method>', params)` escape hatch directly and verify the shape against the backend
  yourself first.
- `update`'s `data` only accepts `status`/`content` in the typed signature — for any other field the
  real `task.updateTask` handler might accept, use `call('task.updateTask', { task_id, ...data })`
  directly.

## See also

- [SDK Reference](../SDK.md) — the full `ctx.sdk` surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
