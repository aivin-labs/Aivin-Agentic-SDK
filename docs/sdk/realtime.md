# 📡 `realtime` — push live events to a workspace or user

The `realtime` namespace lets a plugin push a live event to connected clients while it's still
running — progress updates, partial results, "still working" pings, or any other out-of-band
signal a UI might want to react to before `main()` returns. It is the *only* way Docker-runtime
plugins can stream anything mid-run; the `stream.*` drivers documented in `SDKClient.ts`
are intentionally unimplemented for this runtime and throw if called.

## Import

```typescript
import { realtime } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.realtime
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `publish(params)` | `params: { event: string; data: any; target?: 'workspace' \| 'user' }` | `Promise<{ success: boolean; delivered_to: string \| null }>` | Publish a live event. `event` is a free-form event name; `data` is any JSON-serializable payload. `delivered_to` is the resolved room id (workspace id or user id) the event was emitted to. |

Underlying host call: `realtime.publish`.

## `publish` example

```typescript
import { realtime, log } from '@aivin-labs/sdk';

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

  if (!result.success) {
    // The host could not resolve a target room from this invocation's context
    // (e.g. no workspace/user attached) — the event was not emitted at all.
    log('Realtime event had no resolvable target room', 'warn');
  }

  return { status: 'success', data: { published: result.success } };
}
```

## Notes & caveats

- `target` defaults to `'workspace'` when omitted (per the real SDK's parameter shape) — the host
  resolves the actual recipient (workspace room vs. the specific triggering user); a plugin cannot
  target an arbitrary tenant or user ID outside its own invocation context.
- `delivered_to: null` (always paired with `success: false`) means the host **could not resolve a
  target room** from the invocation context — e.g. the call ran without a workspace/user attached.
  It does *not* mean "nobody was listening": the emit itself is fire-and-forget, so `success: true`
  only confirms the event was emitted to the room, never that a live listener actually received it.
- On the frontend, the socket event name is prefixed: publishing `event: 'report.progress'` arrives
  as **`plugin:report.progress`**, with payload `{ plugin_id, data, timestamp }` (your `data` is
  nested under the `data` key, not spread at the top level).
- There is no subscribe/receive method on the plugin side — `realtime` is publish-only from a
  plugin's perspective. Consuming these events is the frontend's job.
- For anything that needs to happen later rather than "right now while I'm running," use
  `queue.scheduleJob` instead (see `docs/sdk/queue.md`) — `realtime.publish` does not schedule
  anything, it fires immediately.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
