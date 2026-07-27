import { z } from 'zod';

/**
 * Runs `params` through `schema` and throws a single-line, actionable error BEFORE the call ever
 * reaches the network - not a raw zod `ZodError` dump, and not a round-trip to the host followed by
 * a confusing/absent server-side error. This is the fix for the exact failure mode that let
 * `automation.createJob({ name, schedule, logic })` (all three field names wrong) look like it
 * worked in a previous version of this SDK: with no runtime check, a typo or wrong-shaped object
 * only surfaces once - and if - something downstream happens to read a field that silently wasn't
 * set, which can be much later and much harder to trace back to the actual call site.
 */
export function validateParams<T extends z.ZodType>(schema: T, params: unknown, label: string): z.infer<T> {
  const result = schema.safeParse(params);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`[${label}] invalid params - ${issues}`);
  }
  return result.data;
}

/**
 * Schemas below are intentionally narrow: only `automation.*` and `resource.upload` today (the two
 * namespaces a real, previously-shipped bug was found in - see CHANGELOG). Extend this file with
 * the same rigor (verify every field against the real backend handler first, don't guess) rather
 * than schema-ifying every namespace speculatively.
 */

export const createJobParamsSchema = z.object({
  mission: z.string().min(1, 'mission is required'),
  prompt: z.string().optional(),
  agent_id: z.string().min(1, 'agent_id is required - never auto-filled from ctx on this call'),
  workspace_id: z.string().optional(),
  project_id: z.string().optional(),
  schedule_condition: z.string().optional(),
  workflow: z.any().optional(),
  plugin_id: z.string().optional(),
  fresh_execution: z.boolean().optional(),
});

export const updateJobParamsSchema = z
  .object({
    id: z.string().min(1, 'id is required'),
    mission: z.string().optional(),
    schedule_condition: z.string().optional(),
    workflow: z.any().optional(),
    project_id: z.string().optional(),
    agent_id: z.string().optional(),
    plugin_id: z.string().optional(),
    fresh_execution: z.boolean().optional(),
  })
  // Matches the real backend's `[key: string]: any` escape hatch on this call - extra fields are
  // passed through (silently unread unless the backend recognizes them) rather than rejected.
  .catchall(z.any());

export const getJobsParamsSchema = z.object({
  workspace_id: z.string().min(1, 'workspace_id is required (the backend permission check needs it)'),
  mode: z.enum(['workspace', 'personal']).optional(),
  search: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export const deleteJobParamsSchema = z.object({
  id: z.string().min(1, 'id is required'),
});

export const executeByIdParamSchema = z.string().min(1, 'id is required');

export const uploadParamsSchema = z.object({
  file: z.union([
    z.string(),
    z.object({ type: z.literal('Buffer'), data: z.array(z.number()) }),
    z.array(z.number()),
  ]),
  name: z.string().optional(),
  mime: z.string().optional(),
  is_public: z.boolean().optional(),
  temp: z.boolean().optional(),
  workspace_id: z.string().optional(),
});

export const removeParamsSchema = z.object({
  url: z.string().min(1, 'url is required'),
});
