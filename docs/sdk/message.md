# 💬 `message` — save, list, search, and update chat messages

The `message` namespace manages individual messages within a chat session: save a new message,
page through a session's history, fetch the most recent messages, look one up by ID, full-text
search across messages, or update an existing message. This is distinct from `ctx.sdk.session`,
which manages the session/thread container itself (not the messages inside it).

## Import

```typescript
import { message } from '@aivin-labs/sdk';
// equally: ctx.sdk.message / import SDK from '@aivin-labs/sdk'; SDK.message
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `save` | `params: { text: string; role?: 'user' \| 'assistant' \| 'system'; session_id?: string }` | `Promise<void>` | Save a new message. |
| `getList` | `params: { session_id: string; limit?: number; [key: string]: any }` | `Promise<any[]>` | List messages in a session. |
| `getRecent` | `params?: { session_id?: string; limit?: number }` | `Promise<any[]>` | Get the most recent messages (across the current session if `session_id` omitted). |
| `getById` | `params: { message_id: string }` | `Promise<any>` | Fetch a single message by ID. |
| `search` | `params: { query?: string; session_id?: string; limit?: number; [key: string]: any }` | `Promise<any[]>` | Full-text/keyword search across messages. |
| `update` | `params: { message_id: string; [key: string]: any }` | `Promise<any>` | Update an existing message's fields. |

## `save` example

```typescript
import { message } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  await message.save({
    text: 'Here is your generated report.',
    role: 'assistant',
    session_id: ctx.session?.id,
  });
  return { status: 'success' };
}
```

`save`'s payload field is `text` — **not** `content`. Passing `content` silently sends a field the
real handler doesn't read.

## `getList` / `getRecent` example

```typescript
import { message } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const history = await message.getList({ session_id: ctx.session.id, limit: 100 });
  const recent = await message.getRecent({ session_id: ctx.session.id, limit: 10 });
  return { status: 'success', data: { history, recent } };
}
```

## `search` example

```typescript
import { message } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const hits = await message.search({ query: 'refund status', limit: 20 });
  return { status: 'success', data: hits };
}
```

## `getById` / `update` example

```typescript
import { message } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const msg = await message.getById({ message_id: input.messageId });
  const edited = await message.update({ message_id: input.messageId, text: `${msg.text} (edited)` });
  return { status: 'success', data: edited };
}
```

## Notes & caveats

- **`save` reads `text`, not `content`.** This was a real fix against the backend's actual
  `saveMessage` handler (`src/base/SDK.ts`'s `get message()`) — the field name in the SDK's
  TypeScript signature (`text`) must be used verbatim; there is no `content` alias.
- `getList`, `search`, and `update` all accept an index signature (`[key: string]: any`) alongside
  their named fields — the named fields are the confirmed-required/common ones, but the backend
  handlers may accept additional filter/update fields beyond what's typed. When in doubt about an
  extra field's real name, verify against the backend rather than guessing.
- `message` (individual messages) and `session` (`ctx.sdk.session`, the chat/thread container) are
  separate namespaces — use `session.get`/`session.getList`/`session.create`/`session.updateStatus`
  to manage sessions themselves, and `message.*` for the messages inside one.
- None of this namespace's methods carry an "unconfirmed sugar" warning in `SDKClient.ts` beyond the
  `text`-vs-`content` fix above — all six map directly to real backend RPCs (`message.saveMessage`,
  `message.getMessageList`, `message.getRecentMessages`, `message.getMessageById`,
  `message.searchMessages`, `message.updateMessage`).

## See also

- [SDK Reference](../SDK.md) — the full `ctx.sdk` surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
