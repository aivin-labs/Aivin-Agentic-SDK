# 🔔 `notification` — multi-channel push, transactional email, and topic subscriptions

The `notification` namespace covers outbound notifications: a multi-channel dispatch (`push`) that
can land as an in-app push, a Notification Center/DB entry, an internal message, and/or an email —
or a transactional email sent directly (`sendMail`). `subscribeTopic`/`unsubscribeTopic` manage a
user's subscription to a named topic, which `push` can then broadcast to.

## Import

```typescript
import { notification } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.notification
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `push(params)` | see below | `Promise<void>` | Multi-channel notification dispatch to one user, a batch of users, or every subscriber of a topic. |
| `sendMail(params)` | `params: { to: string; subject: string; body: string; [key: string]: any }` | `Promise<void>` | Send a transactional email directly. |
| `subscribeTopic(params)` | `params: { topic: string; user_id?: string }` | `Promise<void>` | Subscribe a user (defaults to the current user if `user_id` omitted) to a named topic. |
| `unsubscribeTopic(params)` | `params: { topic: string; user_id?: string }` | `Promise<void>` | Unsubscribe a user from a named topic. |

Underlying host calls: `notification.pushNotification`, `notification.sendMail`,
`notification.subscribeTopic`, `notification.unsubscribeTopic`.

### `push(params)` fields

At least one audience field is required (validated locally before the call leaves the client):

| Field | Type | Notes |
| --- | --- | --- |
| `user_id` | `string?` | Single recipient. Remapped internally to `receiver_id` — see [Notes & caveats](#notes--caveats). |
| `receiver_ids` | `string[]?` | Batch of recipients, resolved from the DB. |
| `topic` | `string?` | Broadcast to every subscriber of this topic (see `subscribeTopic`). |
| `title` | `string?` | Fixed title text. |
| `body` | `string?` | Fixed message text. Remapped internally to `message` — see below. |
| `prompt` | `string?` | Instead of `title`/`body`, give the backend a short instruction and it AI-generates localized title/message content per recipient. |
| `title_key` / `message_key` | `string?` | i18n keys (`config/i18n/default.json`), rendered per-recipient language. Take precedence over `title`/`body` when set. |
| `vars` | `Record<string, any>?` | `{{var}}` interpolation values for `title_key`/`message_key`. |
| `messageIsHtml` | `boolean?` | Set when `body` is already fully-built HTML (e.g. an invoice) — the email channel sends it as-is instead of wrapping it in the shared template. |
| `priority` | `'low' \| 'normal' \| 'high' \| 'urgent'?` | Determines which engines are even eligible: `low` → push only; `normal` (default) → push+database; `high` → +message; `urgent` → +email too. |
| `channels` | `('database' \| 'push' \| 'message' \| 'email')[]?` | Restricts delivery to exactly these channels — filters *after* `priority` has already picked eligible engines, doesn't substitute for it (e.g. `channels: ['email']` still needs `priority: 'high'`/`'urgent'`). |
| `sender_id` | `string?` | Attributes the notification to a sender (shown in email personalization). |
| `type` | `string?` | A `NotificationType` enum value (90+ members, e.g. `'task_assigned'`, `'general'`) — influences AI-generated fallback content; also used as the topic name when broadcasting without an explicit `topic`. |
| `[key: string]` | `any` | Anything else is passed through best-effort, not guaranteed to be read. |

## `push` examples

```typescript
import { notification } from '@aivin-labs/sdk';

// Fixed content, single recipient, default channels (push + database)
export async function main(mission, input, ctx) {
  await notification.push({
    user_id: ctx.user.id,
    title: 'Report ready',
    body: 'Your weekly report has finished generating.',
  });

  return { status: 'success' };
}
```

```typescript
// Let the backend write the copy for you, urgent priority (push + database + message + email),
// but only actually deliver via database + email
await notification.push({
  user_id: ctx.user.id,
  prompt: 'Tell the user their export finished and is ready to download.',
  priority: 'urgent',
  channels: ['database', 'email'],
});
```

```typescript
// Broadcast to every subscriber of a topic instead of naming recipients
await notification.subscribeTopic({ topic: 'billing-alerts' }); // defaults to current user

await notification.push({
  topic: 'billing-alerts',
  title: 'Billing update',
  body: 'Your invoice is ready.',
  channels: ['database', 'email'],
  priority: 'urgent',
});
```

## `sendMail` example

```typescript
import { notification } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  await notification.sendMail({
    to: input.recipientEmail,
    subject: 'Your export is ready',
    body: 'The export you requested has completed and is attached to your workspace.',
  });

  return { status: 'success' };
}
```

## `subscribeTopic` / `unsubscribeTopic` example

```typescript
import { notification } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  if (input.action === 'subscribe') {
    await notification.subscribeTopic({ topic: 'billing-alerts' }); // defaults to current user
  } else {
    await notification.unsubscribeTopic({ topic: 'billing-alerts', user_id: input.userId });
  }

  return { status: 'success' };
}
```

## Notes & caveats

- **`push()`'s `user_id`/`body` are remapped client-side to `receiver_id`/`message` before the call
  leaves the SDK.** Those are the field names the real backend actually reads — a previous version
  of this SDK sent `user_id`/`body` untranslated, which round-tripped without error but silently
  delivered to nobody (audience resolved to an empty list) and dropped the message text (fell back
  to an AI-generated/generic default instead). If you already pass `receiver_id`/`message`
  directly, those take precedence over a derived `user_id`/`body`.
- `push()` requires at least one of `user_id`, `receiver_id`, `receiver_ids`, or `topic` — enforced
  locally, so a missing/mistyped audience fails immediately instead of vanishing silently.
- `sendMail()`'s param shape was fixed against the real backend — it takes a single `to` (not
  `to`/`user_ids` array) and a single `body` field (not separate `content`/`html` fields), and the
  backend bridge does correctly read `body` (aliased as `html`) here, unlike `push()`'s now-fixed
  mismatch.
- **`sendMail()` does NOT support per-workspace SMTP override**, even though it accepts arbitrary
  extra keys — the backend bridge destructures only `to`/`subject`/`html`/`body` and sends
  directly, ignoring `workspace_id`/`cert`. If you need workspace-scoped
  SMTP, use `push()` with `channels: ['email']` and `priority: 'high'`/`'urgent'` instead — that path
  does read `workspace_id`.
- Both `push` and `sendMail` accept extra arbitrary keys beyond the documented ones, but only the
  fields listed above are guaranteed to be read by the handler; anything else is passed through
  best-effort.
- `subscribeTopic`/`unsubscribeTopic` both make `user_id` optional — omit it to act on the current
  invocation's user rather than passing `ctx.user.id` explicitly.
- None of these methods return a delivery confirmation or message ID — all resolve `void`. If you
  need to know whether a user actually saw something, that's out of scope for this namespace
  (consider `realtime.publish` for confirmed live delivery info, which does return `delivered_to`).

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
