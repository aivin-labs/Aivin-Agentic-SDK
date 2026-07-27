# 🔔 `notification` — in-app push, transactional email, and topic subscriptions

The `notification` namespace covers outbound notifications a plugin sends to a single user: an
in-app push notification, a transactional email, or managing that user's subscription to a named
topic. All four methods resolve `void` — they are fire-and-forget from the plugin's perspective
(the host handles delivery, retries, and channel selection).

## Import

```typescript
import { notification } from '@aivin-labs/sdk';
// equally: ctx.sdk.notification / import SDK from '@aivin-labs/sdk'; SDK.notification
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `push(params)` | `params: { user_id: string; title: string; body: string; [key: string]: any }` | `Promise<void>` | Send an in-app push notification to a single user. |
| `sendMail(params)` | `params: { to: string; subject: string; body: string; [key: string]: any }` | `Promise<void>` | Send a transactional email. |
| `subscribeTopic(params)` | `params: { topic: string; user_id?: string }` | `Promise<void>` | Subscribe a user (defaults to the current user if `user_id` omitted) to a named topic. |
| `unsubscribeTopic(params)` | `params: { topic: string; user_id?: string }` | `Promise<void>` | Unsubscribe a user from a named topic. |

Underlying host calls: `notification.pushNotification`, `notification.sendMail`,
`notification.subscribeTopic`, `notification.unsubscribeTopic`.

## `push` example

```typescript
import { notification } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  await notification.push({
    user_id: ctx.user.id,
    title: 'Report ready',
    body: 'Your weekly report has finished generating.',
  });

  return { status: 'success' };
}
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

- **`push` and `sendMail` param shapes were fixed against the real backend** (`src/base/SDK.ts`'s
  `get notification()`) — they take a single `user_id` (not a `user_ids` array) and a single
  `body` field (not separate `content`/`html` fields). Any older docs, examples, or CodeSDK.d.ts
  declarations implying `user_ids` or `content`/`html` are wrong for the real implementation; do
  not send those shapes.
- Both `push` and `sendMail` accept extra arbitrary keys (`[key: string]: any`) beyond the required
  ones — e.g. `push` can carry a `type` field per `docs/SDK.md`'s example — but only `user_id`,
  `title`, and `body` (for `push`) / `to`, `subject`, and `body` (for `sendMail`) are guaranteed to
  be read by the handler; anything else is passed through best-effort.
- `subscribeTopic`/`unsubscribeTopic` both make `user_id` optional — omit it to act on the current
  invocation's user rather than passing `ctx.user.id` explicitly.
- None of these four methods return a delivery confirmation or message ID — all resolve `void`. If
  you need to know whether a user actually saw something, that's out of scope for this namespace
  (consider `realtime.publish` for confirmed live delivery info, which does return
  `delivered_to`).

## See also

- [SDK Reference](../SDK.md) — the full `ctx.sdk` surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
