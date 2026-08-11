# 📊 `table` — project-scoped tabular database

`table` is a project-scoped tabular database (tables/rows with typed columns), separate from
`store`. Use it when you need user-facing, schema-defined tables that belong to a specific
`workspace_id`/`project_id` — e.g. a table a human can browse in the platform's UI — rather than
`store`'s plugin-private relational key-value rows.

## Import

```typescript
import { table } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.table
```

Every method validates its params locally (zod) before the call goes out — a missing `table_id`/
`workspace_id`/`project_id`, etc. throws immediately with a clear `[table.X] invalid params -
...` message instead of failing obscurely on the host. Note this validation is looser than
`store`'s in a few spots (`columns`, `strategy` are `any` rather than a fixed shape) — this
reflects `table`'s tables having user-defined column structures, not a gap; a fixed union type
doesn't fit a "the user decides the columns" table the way it does `store`'s fixed operation
vocabulary (`op: count|sum|avg|min|max`, etc.).

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `ensureTable` | `params: { purpose: string; workspace_id?: string; project_id?: string; target_columns?: string[] }` | `Promise<any>` | Get-or-create a table matching a described `purpose` (AI-assisted table provisioning). |
| `createTable` | `params: { workspace_id: string; project_id: string; name: string; description?: string; columns: any[]; primary_id?: string; primary_key_column?: string }` | `Promise<any>` | Explicitly create a new table with a defined column list. |
| `getTables` | `params: { workspace_id: string; project_id: string }` | `Promise<any[]>` | List all tables in a project. |
| `getTable` | `params: { workspace_id: string; table_id: string }` | `Promise<any>` | Fetch one table's definition. |
| `updateTable` | `params: { workspace_id: string; table_id: string; name?: string; description?: string; columns?: any[]; primary_id?: string; primary_key_column?: string }` | `Promise<any>` | Update a table's metadata/columns. |
| `deleteTable` | `params: { workspace_id: string; table_id: string }` | `Promise<any>` | Delete a table. |
| `addRow` | `params: { workspace_id: string; project_id: string; table_id: string; data: Record<string, any> }` | `Promise<any>` | Insert one row. |
| `getRow` | `rowId: string` | `Promise<any>` | Fetch one row by ID. |
| `updateRow` | `rowId: string, data: Record<string, any>` | `Promise<any>` | Update one row by ID. |
| `deleteRow` | `rowId: string` | `Promise<any>` | Delete one row by ID. |
| `getRows` | `params: { workspace_id: string; project_id: string; table_id: string; filter?: Record<string, any>; sort?: Record<string, any>; page?: number; limit?: number }` | `Promise<any[]>` | Filtered, sorted, paginated row list. |
| `batchUpdateRows` | `params: { workspace_id: string; project_id: string; table_id: string; filter: Record<string, any>; update: Record<string, any> }` | `Promise<any>` | Update every row matching `filter`. |
| `batchDeleteRows` | `ids: string[]` | `Promise<any>` | Delete multiple rows by ID. |
| `bulkAddRows` | `params: { workspace_id: string; project_id: string; table_id: string; rows: Record<string, any>[] }` | `Promise<any>` | Insert multiple rows in one call. |
| `smartQuery` | `query: string` | `Promise<any>` | Natural-language query over the project's tables (AI-resolved). |
| `batchUpdateByAI` | `instruction: string` | `Promise<any>` | Natural-language batch update instruction (AI-resolved). |
| `searchSemantic` | `params: { query: string; table_id?: string; limit?: number }` | `Promise<any[]>` | Semantic search over row content. |
| `rollback` | `snapshotId: string` | `Promise<any>` | Restores data from a `snapshot_id` returned by `deduplicateTable`/`batchDeleteRows`/`batchUpdateByAI`. |
| `getAllTables` | `params?: { workspace_id?: string; project_id?: string }` | `Promise<any[]>` | Lists every table across a workspace (broader than `getTables`, which is project-scoped). |
| `getTableStats` | `params: { table_id: string; workspace_id?: string; project_id?: string }` | `Promise<any>` | Row count / column / size stats for one table. |
| `countRows` | `params: { table_id: string; workspace_id?: string; project_id?: string }` | `Promise<number>` | Row count for a table (cheaper than `getTableStats` if that's all you need). |
| `exportTable` | `params: { table_id: string; workspace_id?: string; project_id?: string }` | `Promise<any>` | Exports a table's full contents. |
| `deduplicateTable` | `params: { table_id: string; workspace_id?: string; project_id?: string; strategy?: any }` | `Promise<any>` | Removes duplicate rows per `strategy`; returns a `snapshot_id` usable with `rollback`. |
| `backfillColumn` | `params: { table_id: string; workspace_id?: string; project_id?: string; column_key: string; default_value?: any }` | `Promise<any>` | Fills a missing/new column with `default_value` across existing rows; returns a `snapshot_id` usable with `rollback`. |
| `formatRowsForContext` | `params: { table_id: string; workspace_id?: string; project_id?: string; query?: string; token_budget?: number }` | `Promise<string>` | Formats matching rows into an LLM-context-ready string, bounded by `token_budget`. |

## `ensureTable` / `createTable` example

```typescript
import { table as tableSdk } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  // Get-or-create a table by purpose - lets the platform pick/reuse an existing table.
  const table = await tableSdk.ensureTable({
    purpose: 'Track customer support tickets',
    workspace_id: ctx.workspace?.id,
    project_id: input.projectId,
    target_columns: ['subject', 'status', 'priority'],
  });

  // ...or create one explicitly with a fixed schema.
  const explicitTable = await tableSdk.createTable({
    workspace_id: ctx.workspace!.id,
    project_id: input.projectId,
    name: 'Support Tickets',
    description: 'Customer support tickets',
    columns: [
      { key: 'subject', name: 'Subject', type: 'string' },
      { key: 'status', name: 'Status', type: 'string' },
      { key: 'priority', name: 'Priority', type: 'string' },
    ],
    primary_key_column: 'subject',
  });

  return { status: 'success', data: { table, explicitTable } };
}
```

## `getTables` / `getTable` / `updateTable` / `deleteTable` example

```typescript
import { table } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const tables = await table.getTables({
    workspace_id: ctx.workspace!.id,
    project_id: input.projectId,
  });

  const oneTable = await table.getTable({
    workspace_id: ctx.workspace!.id,
    table_id: input.tableId,
  });

  await table.updateTable({
    workspace_id: ctx.workspace!.id,
    table_id: input.tableId,
    description: 'Updated description',
  });

  await table.deleteTable({ workspace_id: ctx.workspace!.id, table_id: input.oldTableId });

  return { status: 'success', data: { tables, oneTable } };
}
```

## `addRow` / `getRow` / `updateRow` / `deleteRow` example

```typescript
import { table } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const row = await table.addRow({
    workspace_id: ctx.workspace!.id,
    project_id: input.projectId,
    table_id: input.tableId,
    data: { subject: input.subject, status: 'open', priority: 'medium' },
  });

  const fetched = await table.getRow(row.id);

  const updated = await table.updateRow(row.id, { status: 'in_progress' });

  await table.deleteRow(row.id);

  return { status: 'success', data: { fetched, updated } };
}
```

## `getRows` example

```typescript
import { table } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const openTickets = await table.getRows({
    workspace_id: ctx.workspace!.id,
    project_id: input.projectId,
    table_id: input.tableId,
    filter: { status: 'open' },
    sort: { created_at: -1 },
    page: 1,
    limit: 25,
  });

  return { status: 'success', data: openTickets };
}
```

## `batchUpdateRows` / `batchDeleteRows` / `bulkAddRows` example

```typescript
import { table } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  await table.batchUpdateRows({
    workspace_id: ctx.workspace!.id,
    project_id: input.projectId,
    table_id: input.tableId,
    filter: { status: 'stale' },
    update: { status: 'archived' },
  });

  await table.batchDeleteRows(input.rowIdsToRemove);

  const added = await table.bulkAddRows({
    workspace_id: ctx.workspace!.id,
    project_id: input.projectId,
    table_id: input.tableId,
    rows: [
      { subject: 'Ticket A', status: 'open' },
      { subject: 'Ticket B', status: 'open' },
    ],
  });

  return { status: 'success', data: added };
}
```

## `smartQuery` / `batchUpdateByAI` / `searchSemantic` example

```typescript
import { table } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const answer = await table.smartQuery('How many open tickets does each customer have?');

  await table.batchUpdateByAI('Mark all tickets older than 30 days with no activity as archived.');

  const matches = await table.searchSemantic({
    query: 'billing complaints',
    table_id: input.tableId,
    limit: 10,
  });

  return { status: 'success', data: { answer, matches } };
}
```

## Notes & caveats

- `updateRow`/`deleteRow`/`smartQuery`/`batchUpdateByAI` signatures are fixed to match the real,
  simpler backend signatures in `src/base/SDK.ts`'s `get table()` — they do **not** take
  `workspace_id`/`project_id`/`ctx`; those are resolved server-side from the caller's identity, not
  passed by the client. Do not add them even if other `table` methods require them.
- `ensureTable` and `getRow` are confirmed in the real backend but were previously missing from this
  client — they've been added here.
- `updateRow(rowId, data)` sends `{ row_id: rowId, ...data }` on the wire; `deleteRow(rowId)` sends
  `{ row_id: rowId }`. `getRow(rowId)` sends `{ id: rowId }` — note the inconsistent field name
  (`id` for get, `row_id` for update/delete) — this is a real backend quirk, not a doc typo.
- `smartQuery` and `batchUpdateByAI` are AI-resolved natural-language operations — their exact
  interpretation and error behavior on ambiguous instructions are not specified in the client;
  treat their results as best-effort.
- `rollback`, `getAllTables`, `getTableStats`, `countRows`, `exportTable`, `deduplicateTable`,
  `backfillColumn`, `formatRowsForContext` were previously only reachable via the HTTP/UI route, not
  through the SDK — `deduplicateTable`/`batchDeleteRows`/`batchUpdateByAI` return a `snapshot_id` you
  can now pass to `rollback` to undo them.
- Named `table`, not `datastore` — the export was renamed to match the real wire namespace
  (`table.*`, see `DatastoreSDK.ts` on the backend) in SDK `1.0.4`. `import { datastore } from
  '@aivin-labs/sdk'` no longer resolves to anything; use `table`.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
