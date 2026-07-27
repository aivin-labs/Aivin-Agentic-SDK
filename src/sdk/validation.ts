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

/**
 * `store.*` schemas - verified field-by-field against the real backend `StoreSDK.ts` (every
 * `params.X` read there matches what `SDKClient.ts` already sent before these schemas existed;
 * unlike `automation`, this namespace's shapes were already correct, so these schemas encode
 * confirmed-correct behavior rather than fixing a bug).
 */
const sortSchema = z.record(z.string(), z.union([z.literal(1), z.literal(-1)])).optional();

export const storeSetParamsSchema = z.object({
  table_id: z.string().min(1, 'table_id is required'),
  key: z.string().min(1, 'key is required'),
  data: z.record(z.string(), z.any()),
  ttl_seconds: z.number().optional(),
  schema: z.any().optional(),
  strict: z.boolean().optional(),
});

export const storeGetParamsSchema = z.object({
  table_id: z.string().min(1, 'table_id is required'),
  key: z.string().min(1, 'key is required'),
});

export const storeDeleteParamsSchema = storeGetParamsSchema;

export const storeBulkParamsSchema = z.object({
  table_id: z.string().min(1, 'table_id is required'),
  rows: z.array(
    z.object({ key: z.string().min(1), data: z.record(z.string(), z.any()), ttlSeconds: z.number().optional() }),
  ),
  schema: z.any().optional(),
});

export const storeQueryParamsSchema = z.object({
  table_id: z.string().min(1, 'table_id is required'),
  filter: z.record(z.string(), z.any()).optional(),
  sort: sortSchema,
  limit: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
});

export const storeCountParamsSchema = z.object({
  table_id: z.string().min(1, 'table_id is required'),
  filter: z.record(z.string(), z.any()).optional(),
});

export const storeSearchParamsSchema = z.object({
  table_id: z.string().min(1, 'table_id is required'),
  query: z.string().min(1, 'query is required'),
  mode: z.enum(['semantic', 'keyword', 'hybrid']).optional(),
  limit: z.number().int().positive().optional(),
  threshold: z.number().optional(),
});

export const storeAggregateParamsSchema = z.object({
  table_id: z.string().min(1, 'table_id is required'),
  metrics: z.array(
    z.object({
      op: z.enum(['count', 'sum', 'avg', 'min', 'max']),
      field: z.string().optional(),
      as: z.string().min(1, 'metrics[].as is required'),
    }),
  ),
  group_by: z.string().optional(),
  filter: z.record(z.string(), z.any()).optional(),
  sort: sortSchema,
  limit: z.number().int().positive().optional(),
});

export const storeCursorParamsSchema = z.object({
  table_id: z.string().min(1, 'table_id is required'),
  filter: z.record(z.string(), z.any()).optional(),
  sort: sortSchema,
  limit: z.number().int().positive().optional(),
  after: z.string().optional(),
});

export const storeTransactionParamsSchema = z.object({
  operations: z
    .array(
      z.union([
        z.object({ op: z.literal('set'), table_id: z.string().min(1), key: z.string().min(1), data: z.record(z.string(), z.any()), ttlSeconds: z.number().optional() }),
        z.object({ op: z.literal('del'), table_id: z.string().min(1), key: z.string().min(1) }),
      ]),
    )
    .min(1, 'operations must have at least one entry'),
});

export const storeJoinParamsSchema = z.object({
  from_table: z.string().min(1, 'from.table is required'),
  from_filter: z.record(z.string(), z.any()).optional(),
  to_table: z.string().min(1, 'to.table is required'),
  to_filter: z.record(z.string(), z.any()).optional(),
  on: z.string().min(1, 'on is required'),
  embed: z.string().optional(),
  limit: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
});

export const storeLinkParamsSchema = z.object({
  source_table: z.string().min(1),
  source_key: z.string().min(1),
  target_table: z.string().min(1),
  target_key: z.string().min(1),
  link_type: z.string().optional(),
  data: z.record(z.string(), z.any()).optional(),
});

export const storeUnlinkParamsSchema = z.object({
  source_table: z.string().min(1),
  source_key: z.string().min(1),
  target_table: z.string().min(1),
  target_key: z.string().min(1),
  link_type: z.string().optional(),
});

export const storeGetLinksParamsSchema = z.object({
  source_table: z.string().min(1),
  source_key: z.string().min(1),
  target_table: z.string().optional(),
  link_type: z.string().optional(),
  reverse: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
});

/**
 * `datastore.*` schemas - verified field-by-field against the real backend `DatastoreSDK.ts`, same
 * "already correct, just adding the runtime guard" situation as `store.*` above.
 */
export const ensureTableParamsSchema = z.object({
  purpose: z.string().min(1, 'purpose is required'),
  workspace_id: z.string().optional(),
  project_id: z.string().optional(),
  target_columns: z.array(z.string()).optional(),
});

export const createTableParamsSchema = z.object({
  workspace_id: z.string().min(1, 'workspace_id is required'),
  project_id: z.string().min(1, 'project_id is required'),
  name: z.string().min(1, 'name is required'),
  description: z.string().optional(),
  columns: z.array(z.any()),
  primary_id: z.string().optional(),
  primary_key_column: z.string().optional(),
});

export const getTablesParamsSchema = z.object({
  workspace_id: z.string().min(1, 'workspace_id is required'),
  project_id: z.string().min(1, 'project_id is required'),
});

export const getTableParamsSchema = z.object({
  workspace_id: z.string().min(1, 'workspace_id is required'),
  table_id: z.string().min(1, 'table_id is required'),
});

export const updateTableParamsSchema = z.object({
  workspace_id: z.string().min(1, 'workspace_id is required'),
  table_id: z.string().min(1, 'table_id is required'),
  name: z.string().optional(),
  description: z.string().optional(),
  columns: z.array(z.any()).optional(),
  primary_id: z.string().optional(),
  primary_key_column: z.string().optional(),
});

export const deleteTableParamsSchema = getTableParamsSchema;

export const addRowParamsSchema = z.object({
  workspace_id: z.string().min(1, 'workspace_id is required'),
  project_id: z.string().min(1, 'project_id is required'),
  table_id: z.string().min(1, 'table_id is required'),
  data: z.record(z.string(), z.any()),
});

export const getRowsParamsSchema = z.object({
  workspace_id: z.string().min(1, 'workspace_id is required'),
  project_id: z.string().min(1, 'project_id is required'),
  table_id: z.string().min(1, 'table_id is required'),
  filter: z.record(z.string(), z.any()).optional(),
  sort: z.record(z.string(), z.any()).optional(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});

export const batchUpdateRowsParamsSchema = z.object({
  workspace_id: z.string().min(1, 'workspace_id is required'),
  project_id: z.string().min(1, 'project_id is required'),
  table_id: z.string().min(1, 'table_id is required'),
  filter: z.record(z.string(), z.any()),
  update: z.record(z.string(), z.any()),
});

export const batchDeleteRowsParamsSchema = z.array(z.string().min(1)).min(1, 'ids must have at least one entry');

export const bulkAddRowsParamsSchema = z.object({
  workspace_id: z.string().min(1, 'workspace_id is required'),
  project_id: z.string().min(1, 'project_id is required'),
  table_id: z.string().min(1, 'table_id is required'),
  rows: z.array(z.record(z.string(), z.any())).min(1, 'rows must have at least one entry'),
});

export const smartQueryParamSchema = z.string().min(1, 'query is required');
export const batchUpdateByAIParamSchema = z.string().min(1, 'instruction is required');
export const rollbackParamSchema = z.string().min(1, 'snapshotId is required');

export const searchSemanticParamsSchema = z.object({
  query: z.string().min(1, 'query is required'),
  table_id: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const getAllTablesParamsSchema = z.object({
  workspace_id: z.string().optional(),
  project_id: z.string().optional(),
});

export const tableIdScopedParamsSchema = z.object({
  table_id: z.string().min(1, 'table_id is required'),
  workspace_id: z.string().optional(),
  project_id: z.string().optional(),
});

export const deduplicateTableParamsSchema = z.object({
  table_id: z.string().min(1, 'table_id is required'),
  workspace_id: z.string().optional(),
  project_id: z.string().optional(),
  strategy: z.any().optional(),
});

export const backfillColumnParamsSchema = z.object({
  table_id: z.string().min(1, 'table_id is required'),
  workspace_id: z.string().optional(),
  project_id: z.string().optional(),
  column_key: z.string().min(1, 'column_key is required'),
  default_value: z.any().optional(),
});

export const formatRowsForContextParamsSchema = z.object({
  table_id: z.string().min(1, 'table_id is required'),
  workspace_id: z.string().optional(),
  project_id: z.string().optional(),
  query: z.string().optional(),
  token_budget: z.number().optional(),
});
