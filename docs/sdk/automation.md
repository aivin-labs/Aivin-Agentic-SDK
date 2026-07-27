# 🔄 `automation` — cron-style automation jobs

CRUD and execution control for scheduled automation jobs — background logic that runs on a cron
schedule independent of any single chat/plugin invocation. Use this when a plugin needs to set up
recurring work (e.g. "run this report every Monday") or manage jobs it previously created.

## Import

```typescript
import { automation } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.automation
```

## Methods

Verified against the backend's real `JobRequest`/`JobListRequest`/`JobResponse` (`AutomationDTO.ts`,
via `AutomationSDK.ts`'s PluginBridge handlers) — **not** the field names you might guess from a
generic "cron job" mental model. In particular: there is no `name` or `schedule` or `logic` field
anywhere on the real backend; a job is defined by `mission`/`prompt` (what to do) and
`schedule_condition` (when — natural language, not raw cron).

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `createJob` | `params: { mission: string; prompt?: string; agent_id: string; workspace_id?: string; project_id?: string; schedule_condition?: string; workflow?: any; plugin_id?: string; fresh_execution?: boolean }` | `Promise<AutomationJob>` | Calls `automation.createJob`. `mission` is a short display name; `prompt` (optional) is the full original request and takes precedence for schedule inference/workflow generation if set. `agent_id` is **required and never auto-filled from `ctx`** on this call path. `workspace_id` falls back to `ctx.workspace`/`ctx.session` if omitted. |
| `updateJob` | `params: { id: string; mission?: string; schedule_condition?: string; workflow?: any; project_id?: string; agent_id?: string; plugin_id?: string; fresh_execution?: boolean; [key: string]: any }` | `Promise<AutomationJob>` | Calls `automation.updateJob`. Partial update by `id` (`job_id` also accepted). Only the listed fields are actually read by the backend — anything else in the index signature is silently ignored, not an error. |
| `getJobs` | `params: { workspace_id: string; mode?: 'workspace' \| 'personal'; search?: string; limit?: number; offset?: number }` | `Promise<AutomationJob[]>` | Calls `automation.getJobs`. `workspace_id` is required — the backend's permission check needs it. `mode: 'workspace'` lists every job in the workspace (requires workspace-admin permission); omitted/`'personal'` lists only jobs the caller created. |
| `deleteJob` | `params: { id: string }` | `Promise<void>` | Calls `automation.deleteJob`. Deletes a job by `id` — only the owning user's own job. |
| `executeById` | `id: string` | `Promise<{ status: string; job_id: string }>` | Calls `automation.executeById` (wraps `id` into `{ id }` for the call). Triggers an immediate, out-of-schedule run — fires the run in the background and returns right away (`status: 'triggered'`), it does not wait for the run to finish. Only the calling user's own job — rejected otherwise. |

Note `executeById` takes `id` as a bare positional string argument, unlike the other four methods
which take a params object.

**All five methods validate `params` locally (zod) before the call goes out** — a wrong shape (e.g.
the pre-fix `{ name, schedule, logic }`) throws immediately with a clear `[automation.X] invalid
params - ...` message instead of silently sending a request the backend partially ignores.

`AutomationJob` shape (from `SDKTypes.ts`, mirrors the backend's real `JobResponse`):

```typescript
interface AutomationJob {
  id: string;
  mission: string;
  prompt?: string;
  workflow?: string[];
  workspace_id: string;
  project_id?: string;
  user_id: string;
  agent_id: string;
  trigger_type?: string; // schedule/interval/delay/manual/random_wakeup — see caveat below
  schedule_condition?: string;
  schedule_config?: Record<string, any>;
  plugin_id?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'limit_exceeded' | 'infeasible' | 'paused';
  last_run?: string;
  last_success?: string;
  last_error?: string;
  next_run?: string;
  success_count?: number;
  consecutive_errors?: number;
  is_disabled?: boolean;
  disabled_reason?: string;
  created_date?: string;
}
```

## `createJob` example

```typescript
import { automation } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const job = await automation.createJob({
    mission: 'Weekly digest',
    prompt: 'Compile last week\'s support tickets into a summary and post it to #digest.',
    agent_id: ctx.session?.agent_id ?? input.agentId,
    workspace_id: ctx.workspace?.id,
    schedule_condition: 'every Monday at 9am', // natural language, not a cron string
  });
  return { status: 'success', data: job };
}
```

If you omit `schedule_condition` entirely, the backend infers a schedule (or falls back to manual)
from `prompt`/`mission` using its own AI-based inference — pass it explicitly if you already know
the cadence, to avoid an extra inference call and a possibly-wrong guess.

## `updateJob` example

```typescript
import { automation } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const updated = await automation.updateJob({
    id: input.jobId,
    schedule_condition: 'daily at 8am', // move to daily 8am
  });
  return { status: 'success', data: updated };
}
```

## `getJobs` / `deleteJob` / `executeById` example

```typescript
import { automation } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const jobs = await automation.getJobs({ workspace_id: ctx.workspace?.id, limit: 20 });

  const stale = jobs.find((j) => j.mission === 'Old report');
  if (stale) {
    await automation.deleteJob({ id: stale.id });
  }

  const active = jobs.find((j) => j.mission === 'Weekly digest');
  if (active) {
    const result = await automation.executeById(active.id);
    return { status: 'success', data: result };
  }

  return { status: 'success', data: jobs };
}
```

## Notes & caveats

- There is no `logic`/code-string field on a job at all — what a job actually *does* is either
  `prompt` (free text the agent acts on each run, same as a normal chat mission) or `workflow` (a
  structured step list), never an executable string a plugin author writes directly.
- `trigger_type` on `AutomationJob` is a **different, unrelated concept** from the plugin manifest's
  own `TriggerType` export (`manual`/`schedule`/`event`/`webhook`/`api`/`chat`/`widget`, see
  [MANIFEST.md](../MANIFEST.md#trigger-types)) despite sharing some member names — this one is the
  automation *scheduling* mechanism (`schedule`/`interval`/`delay`/`manual`/`random_wakeup`), set
  automatically by the backend from `schedule_condition`, not something you choose directly.
- `updateJob`'s `[key: string]: any` index signature is a real escape hatch for forward-compat, but
  today only `mission`/`schedule_condition`/`workflow`/`project_id`/`agent_id`/`fresh_execution`/
  `plugin_id` are actually read — anything else is accepted but silently has no effect (not an
  error), including a `status` field if you're tempted to set one directly.
- `createJob`'s `agent_id` is the one field on this call path that is **never** auto-filled from
  `ctx` (unlike `workspace_id`, which falls back to `ctx.workspace`/`ctx.session`) — omitting it
  throws `agent_id is required to create a job`.
- Rate limited server-side per user: 10 calls per 5 minutes, shared between `createJob` and
  `updateJob` — but `updateJob` only counts against it when `mission` or `schedule_condition`
  actually changes (those are the only branches that trigger an LLM call internally); changing
  `workflow`/`project_id`/etc. alone doesn't consume the quota.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
