# 📡 `realtime` — push live events to a workspace or user

The `realtime` namespace lets a plugin push a live event to connected clients while it's still
running — progress updates, partial results, "still working" pings, or any other out-of-band
signal a UI might want to react to before `main()` returns. It is the *only* way Docker-runtime
plugins can stream anything mid-run; the `ctx.sdk.stream.*` drivers documented in `SDKClient.ts`
are intentionally unimplemented for this runtime and throw if called.

## Import

```typescript
import { realtime } from '@aivin-labs/sdk';
// equally: ctx.sdk.realtime / import SDK from '@aivin-labs/sdk'; SDK.realtime
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `publish(params)` | `params: { event: string; data: any; target?: 'workspace' \| 'user' }` | `Promise<{ success: boolean; delivered_to: string \| null }>` | Publish a live event. `event` is a free-form event name your frontend listens for; `data` is any JSON-serializable payload. |

Underlying host call: `realtime.publish`.

## `publish` example

```typescript
import { realtime } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  await realtime.publish({
    event: 'report.progress',
    data: { step: 'fetching-data', percent: 25 },
    target: 'workspace', // or 'user' to notify only the triggering user
  });

  // ... do work ...

  const result = await realtime.publish({
    event: 'report.complete',
    data: { reportId: 'r_123' },
    target: 'user',
  });

  if (!result.delivered_to) {
    ctx.sdk.log('No active listener received the event', 'warn');
  }

  return { status: 'success', data: { published: result.success } };
}
```

## Notes & caveats

- `target` defaults to `'workspace'` when omitted (per the real SDK's parameter shape) — the host
  resolves the actual recipient (workspace room vs. the specific triggering user); a plugin cannot
  target an arbitrary tenant or user ID outside its own invocation context.
- `delivered_to` in the response can be `null` — this means no live listener was connected to
  receive the event at publish time. It is not an error; the call still succeeds (`success: true`
  is possible alongside `delivered_to: null`), it just means nobody was there to see it live.
- There is no subscribe/receive method on the plugin side — `realtime` is publish-only from a
  plugin's perspective. Consuming these events is the frontend's job.
- For anything that needs to happen later rather than "right now while I'm running," use
  `queue.scheduleJob` instead (see `docs/sdk/queue.md`) — `realtime.publish` does not schedule
  anything, it fires immediately.

## See also

- [SDK Reference](../SDK.md) — the full `ctx.sdk` surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
