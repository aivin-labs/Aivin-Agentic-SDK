# ⏱️ `queue` — schedule a future call back into this same plugin

The `queue` namespace lets a plugin schedule a delayed **self-continuation**: the host will
re-invoke this *same plugin's* `main()` again later with whatever `input` you provide. It is not a
generic job queue for calling other plugins or arbitrary functions — think of it as "call myself
again in N milliseconds with this state," which is the building block for polling loops, delayed
follow-ups, retry-after-cooldown logic, and multi-step workflows that need to pause between steps.

## Import

```typescript
import { queue } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.queue
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `scheduleJob(params)` | `params: { input: Record<string, any>; delay_ms?: number }` | `Promise<{ job_id: string }>` | Schedule a future re-invocation of **this same plugin's** `main()`, passing `input` as the new invocation's `input` argument, after `delay_ms` (if omitted, the host's default delay applies). |

Underlying host call: `queue.scheduleJob`.

## `scheduleJob` example

```typescript
import { queue } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  // First run: kick off work, then schedule a follow-up check of this same plugin.
  if (!input.phase) {
    await kickOffLongRunningExternalJob(input);

    const { job_id } = await queue.scheduleJob({
      input: { phase: 'poll', externalJobId: input.externalJobId },
      delay_ms: 60_000, // re-invoke main() with this input in 1 minute
    });

    return { status: 'success', data: { scheduled: job_id } };
  }

  // Second run (phase === 'poll'): main() is called again by the host with the input above.
  const done = await checkExternalJobStatus(input.externalJobId);
  if (!done) {
    // Not ready yet — reschedule another poll.
    await queue.scheduleJob({ input, delay_ms: 30_000 });
    return { status: 'success', data: { still_waiting: true } };
  }

  return { status: 'success', data: { done: true } };
}
```

## Notes & caveats

- **Self-continuation, not cross-plugin dispatch.** `scheduleJob` schedules a call back to this
  same plugin, delivered as a fresh `main(mission, input, ctx)` invocation with `input` set to
  whatever object you passed. It is easy to mistake this for a general-purpose task queue that can
  invoke a *different* plugin or function — it cannot. If you need that, look at `automation.*` or
  `agent.delegate`/`a2a` instead.
- Your plugin's `main()` needs its own logic (e.g. an `input.phase` / state flag, as in the example
  above) to distinguish "this is the original trigger" from "this is my own scheduled follow-up" —
  the SDK does not do this bookkeeping for you.
- `delay_ms` is optional; when omitted the host applies its own default delay. If you need a
  specific wait, always pass `delay_ms` explicitly.
- The returned `job_id` is for reference/logging — there is no `queue.cancelJob` or
  `queue.getJob` sugar method on `SDKClient.ts`; if the platform exposes one at the host level,
  use `call('queue.cancelJob', ...)` etc. directly, but its existence/shape is
  **unconfirmed** here.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
