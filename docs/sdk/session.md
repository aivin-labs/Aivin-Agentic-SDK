# 💭 `session` — chat session management

`session` manages `MessageSession` records — the chat/automation session a plugin run is attached
to (also available directly as `ctx.session` for the current run's own session). Use it to look up,
list, create, or update sessions other than (or in addition to) the current one, and to drive a
session's status/seen state for UI purposes.

## Import

```typescript
import { session } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.session
```

## The `MessageSession` shape

```typescript
interface MessageSession {
  id: string;
  client: string;
  workspace_id: string;
  user_id: string;
  agent_id?: string;
  name?: string;
  message_count: number;
  thread_id: string;
  status?: 'idle' | 'processing' | 'completed';
}
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `get` | `session_id: string` | `Promise<MessageSession>` | Fetch one session by ID. |
| `getList` | `params?: { workspace_id?: string; user_id?: string; limit?: number; [key: string]: any }` | `Promise<MessageSession[]>` | List sessions matching filters. |
| `markAsSeen` | `params: { session_id: string; workspace_id: string; user_id: string }` | `Promise<any>` | Mark a session as seen by a user (clears unread indicators). |
| `update` | `params: { id: string; [key: string]: any }` | `Promise<any>` | Update arbitrary fields on a session by ID. |
| `newSession` | `params: Record<string, any>` | `Promise<MessageSession>` | Create a new session (distinct host call from `create`, see caveats). |
| `create` | `params: Record<string, any>` | `Promise<MessageSession>` | Create a new session. |
| `updateStatus` | `params: { session_id: string; status: 'idle' \| 'processing' \| 'completed' }` | `Promise<any>` | Set a session's processing status. |

## `get` example

```typescript
import { session } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const s = await session.get(input.sessionId);
  return { status: 'success', data: s };
}
```

## `getList` example

```typescript
import { session } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const sessions = await session.getList({
    workspace_id: ctx.workspace?.id,
    user_id: ctx.user?.id,
    limit: 20,
  });
  return { status: 'success', data: sessions };
}
```

## `markAsSeen` example

```typescript
import { session } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  await session.markAsSeen({
    session_id: input.sessionId,
    workspace_id: ctx.workspace!.id,
    user_id: ctx.user!.id,
  });
  return { status: 'success' };
}
```

## `update` example

```typescript
import { session } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const updated = await session.update({ id: input.sessionId, name: 'Renamed session' });
  return { status: 'success', data: updated };
}
```

## `newSession` / `create` example

```typescript
import { session } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  // Both create a session - see Notes below on which one to prefer if unsure.
  const s1 = await session.newSession({
    workspace_id: ctx.workspace!.id,
    user_id: ctx.user!.id,
    name: 'New conversation',
  });

  const s2 = await session.create({
    workspace_id: ctx.workspace!.id,
    user_id: ctx.user!.id,
    name: 'Another conversation',
  });

  return { status: 'success', data: { s1, s2 } };
}
```

## `updateStatus` example

```typescript
import { session } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  await session.updateStatus({ session_id: input.sessionId, status: 'processing' });
  // ... do work ...
  await session.updateStatus({ session_id: input.sessionId, status: 'completed' });
  return { status: 'success' };
}
```

## Notes & caveats

- `newSession` and `create` call two distinct host methods (`session.newSession` and
  `session.createSession` respectively) — the SDK client does not document or enforce a difference
  in behavior between them beyond that; if the distinction matters for your use case (e.g. one may
  be the "resume-or-create" variant used internally by chat UIs), verify against the backend rather
  than assuming they're interchangeable.
  - `ctx.session` (the 3rd `main()` argument's `session` field) gives you the *current* run's
  session directly, typed as `MessageSession` — reach for `session.get(ctx.session.id)` only if you
  need a fresh read rather than the snapshot passed into `main()`.
- `update`'s `params` takes `id`, not `session_id` — inconsistent with every other method in this
  namespace, which take `session_id`. This is a real signature detail from `SDKClient.ts`, not a
  doc typo — double check which field name you're passing.
- `getList` and `create`/`newSession` accept an open-ended `[key: string]: any` / `Record<string,
  any>` bag beyond the documented fields — the full set of accepted filter/creation fields is not
  fully enumerated in the client; treat undocumented fields as best-effort passthrough to the host.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
