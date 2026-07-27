# 🍃 `mongo` — isolated document collections with Mongoose-style query shapes

`mongo` gives you isolated document storage backed by MongoDB on the host, scoped to this plugin +
tenant. It's for teams that prefer Mongo query shapes (`find`, `updateOne`, `aggregate` pipelines,
...) over `store`'s relational key-value model — note it does not have `store`'s built-in
search/graph features, so reach for `store` first unless you specifically want Mongo semantics.

## Import

```typescript
import { mongo } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.mongo
```

## Methods

`mongo.model(name, schema?)` returns a Mongoose-style handle bound to the collection `name`. The
`schema` argument is accepted for API-shape parity but is not otherwise used by the client (it isn't
sent to the host or validated). Every method below is called on the object `model()` returns.

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `create` | `doc: Record<string, any>` | `Promise<any>` | Insert a single document. |
| `insertMany` | `docs: Record<string, any>[]` | `Promise<any>` | Insert multiple documents. |
| `find` | `query?: Record<string, any>, options?: Record<string, any>` | `Promise<any[]>` | Find matching documents. |
| `findOne` | `query?: Record<string, any>` | `Promise<any \| null>` | Find the first matching document. |
| `countDocuments` | `query?: Record<string, any>` | `Promise<number>` | Count matching documents. |
| `updateMany` | `query: Record<string, any>, update: Record<string, any>, options?: Record<string, any>` | `Promise<any>` | Update all matching documents. |
| `updateOne` | `query: Record<string, any>, update: Record<string, any>, options?: Record<string, any>` | `Promise<any>` | Update the first matching document. |
| `findOneAndUpdate` | `query: Record<string, any>, update: Record<string, any>, options?: Record<string, any>` | `Promise<any>` | Update and return the (by default, pre-update) document. |
| `findOneAndDelete` | `query: Record<string, any>` | `Promise<any>` | Delete and return the matched document. |
| `deleteMany` | `query: Record<string, any>` | `Promise<any>` | Delete all matching documents. |
| `deleteOne` | `query: Record<string, any>` | `Promise<any>` | Delete the first matching document. |
| `aggregate` | `pipeline: any[]` | `Promise<any[]>` | Run a Mongo aggregation pipeline. |

## `create` / `insertMany` example

```typescript
import { mongo } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const Logs = mongo.model('logs');

  const single = await Logs.create({ level: 'info', message: input.message, ts: new Date() });
  const many = await Logs.insertMany([
    { level: 'info', message: 'step 1 done', ts: new Date() },
    { level: 'info', message: 'step 2 done', ts: new Date() },
  ]);

  return { status: 'success', data: { single, many } };
}
```

## `find` / `findOne` / `countDocuments` example

```typescript
import { mongo } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const Logs = mongo.model('logs');

  const recent = await Logs.find({ level: 'error' }, { sort: { ts: -1 }, limit: 20 });
  const latest = await Logs.findOne({ level: 'error' });
  const errorCount = await Logs.countDocuments({ level: 'error' });

  return { status: 'success', data: { recent, latest, errorCount } };
}
```

## `updateOne` / `updateMany` example

```typescript
import { mongo } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const Tickets = mongo.model('tickets');

  await Tickets.updateOne({ _id: input.ticketId }, { $set: { status: 'resolved' } });
  await Tickets.updateMany({ status: 'stale' }, { $set: { status: 'archived' } });

  return { status: 'success' };
}
```

## `findOneAndUpdate` example

```typescript
import { mongo } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const Counters = mongo.model('counters');

  const updated = await Counters.findOneAndUpdate(
    { name: 'invoice_seq' },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' },
  );

  return { status: 'success', data: updated };
}
```

## `findOneAndDelete` / `deleteOne` / `deleteMany` example

```typescript
import { mongo } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const Sessions = mongo.model('sessions');

  const removed = await Sessions.findOneAndDelete({ _id: input.sessionId });
  await Sessions.deleteOne({ token: input.staleToken });
  await Sessions.deleteMany({ expires_at: { $lt: new Date() } });

  return { status: 'success', data: removed };
}
```

## `aggregate` example

```typescript
import { mongo } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const Orders = mongo.model('orders');

  const revenueByStatus = await Orders.aggregate([
    { $match: { customer: input.customerId } },
    { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);

  return { status: 'success', data: revenueByStatus };
}
```

## Notes & caveats

- Matches `CodeSDK.d.ts`'s `mongo: { model(name, schema) }` shape: `model(name)` returns a
  Mongoose-style handle bound to that collection name; every method on it calls one of the
  `storage.mongo*` namespaces confirmed against `PluginStorageService` on the backend. This is
  **not** a direct MongoDB connection — Docker-runtime plugins never receive raw database
  credentials.
- The `schema` argument to `model(name, schema)` is accepted only for shape parity with Mongoose —
  it is not sent to the host and has no validation effect in this client.
- Every method sends `collection: name` (the value you passed to `model()`) alongside your
  query/update/pipeline — this is the same friendly-name-to-wire-param pattern as `store`'s
  `table_id` and `redis`'s underlying `storage.*` calls.
- `updateOne` and `updateMany` map to two distinct host methods (`storage.mongoUpdateOne` and
  `storage.mongoUpdate` respectively) — they are not the same call with a flag, so behavior
  differences between "one" and "many" semantics are enforced host-side, not client-side.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
