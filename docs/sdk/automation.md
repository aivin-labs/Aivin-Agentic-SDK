# 🔄 `automation` — cron-style automation jobs

CRUD and execution control for scheduled automation jobs — background logic that runs on a cron
schedule independent of any single chat/plugin invocation. Use this when a plugin needs to set up
recurring work (e.g. "run this report every Monday") or manage jobs it previously created.

## Import

```typescript
import { automation } from '@aivin/sdk';
// equally: ctx.sdk.automation / import SDK from '@aivin/sdk'; SDK.automation
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `createJob` | `params: { name: string; schedule?: string; logic: string }` | `Promise<any>` | Calls `automation.createJob`. Creates a new automation job. `schedule` is presumably a cron expression (not typed/validated client-side); `logic` is the job's executable definition as a string. |
| `updateJob` | `params: { id: string; name?: string; schedule?: string; logic?: string; [key: string]: any }` | `Promise<any>` | Calls `automation.updateJob`. Partial update by `id`. The `[key: string]: any` index signature means extra fields are passed through untyped. |
| `getJobs` | `params?: { workspace_id?: string; limit?: number }` | `Promise<any[]>` | Calls `automation.getJobs`. Lists jobs, optionally scoped to a workspace and capped at `limit`. |
| `deleteJob` | `params: { id: string }` | `Promise<any>` | Calls `automation.deleteJob`. Deletes a job by `id`. |
| `executeById` | `id: string` | `Promise<any>` | Calls `automation.executeById` (wraps `id` into `{ id }` for the call). Triggers an immediate, out-of-schedule run of the job. |

Note `executeById` takes `id` as a bare positional string argument, unlike the other four methods
which take a params object.

## `createJob` example

```typescript
import { automation } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  const job = await automation.createJob({
    name: 'Weekly digest',
    schedule: '0 9 * * MON',
    logic: JSON.stringify({ action: 'sendDigest', workspace_id: ctx.workspace?.id }),
  });
  return { status: 'success', data: job };
}
```

## `updateJob` example

```typescript
import { automation } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  const updated = await automation.updateJob({
    id: input.jobId,
    schedule: '0 8 * * *', // move to daily 8am
  });
  return { status: 'success', data: updated };
}
```

## `getJobs` / `deleteJob` / `executeById` example

```typescript
import { automation } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  const jobs = await automation.getJobs({ limit: 20 });

  const stale = jobs.find((j) => j.name === 'Old report');
  if (stale) {
    await automation.deleteJob({ id: stale.id });
  }

  const active = jobs.find((j) => j.name === 'Weekly digest');
  if (active) {
    const result = await automation.executeById(active.id);
    return { status: 'success', data: result };
  }

  return { status: 'success', data: jobs };
}
```

## Notes & caveats

- All five methods return `any`/`any[]` in `SDKClient.ts` — no confirmed typed job shape exists in
  this SDK. Field names on a returned job object (e.g. whether it's `schedule` or `cron`, `logic`
  or `code`) are inferred from the input params, not independently confirmed for the response.
- `schedule`'s expected format (cron string vs. something else) is not validated or documented at
  the client level — treat it as opaque and match whatever your backend's automation engine
  expects.
- `logic`'s format (raw code string, serialized JSON, DSL, etc.) is likewise unconfirmed beyond
  "it's a `string`" — check your tenant's automation engine docs/UI for the expected content.
- `updateJob`'s `[key: string]: any` index signature is a deliberate escape hatch for fields beyond
  `name`/`schedule`/`logic` — but anything passed through it is untyped and unverified against the
  backend.

## See also

- [SDK Reference](../SDK.md) — the full `ctx.sdk` surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
