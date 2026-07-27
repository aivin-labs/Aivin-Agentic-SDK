# 🗄️ `store` — relational key-value store with schema, graph edges, and hybrid search

`store` is the recommended default for plugin-persisted data. It's a relational key-value store,
scoped to this plugin + tenant on the host: every row lives in a `table` (a friendly name you pick)
under a unique `key`, can carry an optional column `schema`, can be linked to rows in other tables
via graph edges (`link`/`unlink`/`getLinks`), and supports semantic/keyword/hybrid `search`,
`aggregate`, cursor-based pagination, and atomic multi-row `transaction`s. Reach for it before
`redis` (no schema/search/graph) or `mongo` (no built-in search/graph) unless you specifically need
a raw cache or Mongo query shapes.

## Import

```typescript
import { store } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.store
```

## Wire mapping note

Every `store` method takes a friendly `table` string in your code, but the SDK sends it to the host
as `table_id` under the hood (e.g. `store.set('orders', ...)` → wire params `{ table_id: 'orders',
... }`). You never construct or see the wire shape yourself — this is purely so you understand what
a network trace or `call('store.set', ...)` escape-hatch invocation must include. `store.join` and
`store.transaction` each do their own variant of this mapping (see their sections below) — in
particular, **`transaction` silently drops any operation that doesn't get a `table_id` alias
attached**, which the SDK handles for you automatically; only a concern if you bypass the sugar
method and call `store.transaction` via `call()` directly.

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `set` | `table: string, key: string, data: Record<string, any>, ttlSeconds?: number, schema?: { name: string; description?: string; columns: Array<{ key: string; name: string; type: string; options?: string[] }> }, options?: { strict?: boolean }` | `Promise<any>` | Upsert one row. `schema` optionally declares/validates column shape for the table; `options.strict` rejects data that doesn't match it. `ttlSeconds` expires the row automatically. |
| `get` | `table: string, key: string` | `Promise<any \| null>` | Fetch one row by key, or `null` if missing. |
| `del` | `table: string, key: string` | `Promise<{ deleted: boolean }>` | Delete one row by key. |
| `bulk` | `table: string, rows: Array<{ key: string; data: Record<string, any>; ttlSeconds?: number }>, schema?: any` | `Promise<{ success: number; failed: number }>` | Upsert many rows in one call. |
| `query` | `table: string, filter?: Record<string, any>, sort?: Record<string, 1 \| -1>, limit?: number, page?: number` | `Promise<any[]>` | Filtered, sorted, paginated list read. |
| `count` | `table: string, filter?: Record<string, any>` | `Promise<number>` | Count rows matching `filter` without fetching them. |
| `search` | `table: string, query: string, options?: { mode?: 'semantic' \| 'keyword' \| 'hybrid'; limit?: number; threshold?: number }` | `Promise<Array<any & { _similarity: number }>>` | Semantic/keyword/hybrid search over row content; each hit is annotated with `_similarity`. |
| `aggregate` | `table: string, metrics: Array<{ op: 'count' \| 'sum' \| 'avg' \| 'min' \| 'max'; field?: string; as: string }>, options?: { groupBy?: string; filter?: Record<string, any>; sort?: Record<string, 1 \| -1>; limit?: number }` | `Promise<any[]>` | Grouped aggregation (SQL `GROUP BY`-style). |
| `cursor` | `table: string, filter?: Record<string, any>, options?: { sort?: Record<string, 1 \| -1>; limit?: number; after?: string }` | `Promise<{ rows: any[]; next: string \| null }>` | Cursor-based pagination — pass the previous call's `next` back in as `after` to continue; `next: null` means no more rows. |
| `transaction` | `operations: Array<{ op: 'set'; table: string; key: string; data: Record<string, any>; ttlSeconds?: number } \| { op: 'del'; table: string; key: string }>` | `Promise<void>` | Apply multiple `set`/`del` operations atomically, possibly across different tables. |
| `join` | `params: { from: { table: string; filter?: Record<string, any> }; to: { table: string; filter?: Record<string, any> }; on: string; embed?: string; limit?: number; page?: number }` | `Promise<any[]>` | Relational join between two tables on a shared field. |
| `link` | `sourceTable: string, sourceKey: string, targetTable: string, targetKey: string, linkType?: string, data?: Record<string, any>` | `Promise<any>` | Create a graph edge between two rows (in the same or different tables). |
| `unlink` | `sourceTable: string, sourceKey: string, targetTable: string, targetKey: string, linkType?: string` | `Promise<{ deleted: number }>` | Remove edge(s) between two rows. |
| `getLinks` | `sourceTable: string, sourceKey: string, options?: { targetTable?: string; type?: string; reverse?: boolean; limit?: number }` | `Promise<Array<{ id: string; source_table: string; source_key: string; target_table: string; target_key: string; link_type: string; data: Record<string, any>; created_at: Date }>>` | List edges from (or, with `reverse: true`, to) a row. |

## `set` example

```typescript
import { store } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const order = await store.set(
    'orders',
    input.orderId,
    { total: input.total, status: 'paid', customer: input.customerId },
    undefined, // ttlSeconds - no expiry
    {
      name: 'Orders',
      description: 'Customer orders',
      columns: [
        { key: 'total', name: 'Total', type: 'number' },
        { key: 'status', name: 'Status', type: 'string', options: ['pending', 'paid', 'refunded'] },
        { key: 'customer', name: 'Customer ID', type: 'string' },
      ],
    },
    { strict: true },
  );
  return { status: 'success', data: order };
}
```

## `get` example

```typescript
import { store } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const order = await store.get('orders', input.orderId);
  if (!order) {
    return { status: 'error', message: 'Order not found' };
  }
  return { status: 'success', data: order };
}
```

## `del` example

```typescript
import { store } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const { deleted } = await store.del('orders', input.orderId);
  return { status: 'success', data: { deleted } };
}
```

## `bulk` example

```typescript
import { store } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const result = await store.bulk('orders', [
    { key: 'ord_1', data: { total: 10, status: 'paid' } },
    { key: 'ord_2', data: { total: 25, status: 'pending' }, ttlSeconds: 3600 },
  ]);
  // { success: 2, failed: 0 }
  return { status: 'success', data: result };
}
```

## `query` example

```typescript
import { store } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const recent = await store.query(
    'orders',
    { status: 'paid' },
    { created_at: -1 }, // newest first
    20, // limit
    1, // page
  );
  return { status: 'success', data: recent };
}
```

## `count` example

```typescript
import { store } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const pendingCount = await store.count('orders', { status: 'pending' });
  return { status: 'success', data: { pendingCount } };
}
```

## `search` example

```typescript
import { store } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const hits = await store.search('support_tickets', input.query, {
    mode: 'hybrid',
    limit: 10,
    threshold: 0.7,
  });
  // each hit: { ...row, _similarity: 0.83 }
  return { status: 'success', data: hits };
}
```

## `aggregate` example

```typescript
import { store } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const revenueByStatus = await store.aggregate(
    'orders',
    [
      { op: 'sum', field: 'total', as: 'total_revenue' },
      { op: 'count', as: 'order_count' },
    ],
    { groupBy: 'status', filter: { customer: input.customerId }, sort: { total_revenue: -1 } },
  );
  return { status: 'success', data: revenueByStatus };
}
```

## `cursor` example

```typescript
import { store } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  let after: string | undefined;
  const allRows: any[] = [];

  do {
    const page = await store.cursor('orders', { status: 'paid' }, { limit: 100, after });
    allRows.push(...page.rows);
    after = page.next ?? undefined;
  } while (after);

  return { status: 'success', data: { count: allRows.length } };
}
```

## `transaction` example

```typescript
import { store } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  // Atomically move an order from "pending" to "paid" and record a ledger entry.
  await store.transaction([
    { op: 'set', table: 'orders', key: input.orderId, data: { status: 'paid' } },
    {
      op: 'set',
      table: 'ledger',
      key: `${input.orderId}:payment`,
      data: { orderId: input.orderId, amount: input.total },
    },
    { op: 'del', table: 'pending_reminders', key: input.orderId },
  ]);
  return { status: 'success' };
}
```

## `join` example

```typescript
import { store } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const ordersWithCustomers = await store.join({
    from: { table: 'orders', filter: { status: 'paid' } },
    to: { table: 'customers' },
    on: 'customerId', // field shared between the two tables
    embed: 'customer', // embed the matched customer row under this key
    limit: 50,
  });
  return { status: 'success', data: ordersWithCustomers };
}
```

## `link` / `unlink` / `getLinks` example

```typescript
import { store } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  // Link an order to the customer that placed it.
  await store.link('orders', input.orderId, 'customers', input.customerId, 'placed_by', {
    linked_at: new Date().toISOString(),
  });

  // Read back all edges from that order.
  const edges = await store.getLinks('orders', input.orderId, { type: 'placed_by' });

  // ...or walk the edge in reverse, from the customer's side.
  const customerOrders = await store.getLinks('customers', input.customerId, {
    targetTable: 'orders',
    type: 'placed_by',
    reverse: true,
  });

  // Remove the edge (e.g. order cancelled/reassigned).
  const { deleted } = await store.unlink('orders', input.orderId, 'customers', input.customerId, 'placed_by');

  return { status: 'success', data: { edges, customerOrders, deleted } };
}
```

## Notes & caveats

- Data is scoped to this plugin + tenant on the host side (per `CodeSDK.d.ts`'s `store` contract) —
  you cannot read or write another plugin's or tenant's rows through `store`.
- Every method sends `table` as `table_id` on the wire (`store.set` → `{ table_id: table, ... }`,
  etc.) — a naming detail only, transparent when using the sugar methods.
- `transaction`: **each operation must carry a `table_id` alias of its `table`** — the real backend
  handler reads `table_id`, not `table`, so an operation without it is silently dropped rather than
  applied. The SDK's `transaction()` sugar method does this mapping for you automatically
  (`operations.map((op) => ({ ...op, table_id: op.table }))`); this is only a concern if you bypass
  the sugar method and call `call('store.transaction', ...)` directly — you must add `table_id`
  yourself in that case.
- `join` sends `from_table`/`from_filter`/`to_table`/`to_filter` on the wire, derived from your
  `params.from`/`params.to` objects — again transparent through the sugar method, but relevant if
  you use `call()` directly.
- `search`'s `_similarity` field is only meaningful for `semantic`/`hybrid` modes; for `keyword`
  mode treat it as a relevance score rather than a true cosine similarity (exact scoring semantics
  are not specified in the client — verify empirically if precision matters).

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
