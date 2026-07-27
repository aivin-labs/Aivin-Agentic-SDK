# 📦 `resource` — raw blob storage (upload / remove)

The `resource` namespace is the SDK's raw blob-storage primitive: upload arbitrary file content
and get back a stored object (typically including a URL), or remove a previously uploaded blob by
URL. It is deliberately minimal — two methods, no listing/searching/metadata management. Reach for
`file.*` instead when you want workspace-level document records (titles, search, listing); reach
for `resource` when you just need "put these bytes somewhere and get a URL back."

## Import

```typescript
import { resource } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.resource
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `upload(params)` | `params: { file: string \| { type: 'Buffer'; data: number[] } \| number[]; name?: string; mime?: string; is_public?: boolean; temp?: boolean; workspace_id?: string }` | `Promise<ResourceMeta>` | Upload a file blob to storage. |
| `remove(params)` | `params: { url: string }` | `Promise<any>` | Remove a previously uploaded blob by its URL. |

Underlying host calls: `resource.uploadFile`, `resource.removeFile`.

Both methods validate `params` locally (zod) before the call goes out — passing a `file` that
isn't one of the three accepted shapes, or an empty `url` to `remove`, throws immediately with a
clear `[resource.X] invalid params - ...` message instead of failing obscurely on the host.

`ResourceMeta` shape (from `SDKTypes.ts`, verified against the backend's real `FSIO.ts`):

```typescript
interface ResourceMeta {
  id: string;
  name?: string;
  size?: number | string;
  user_id?: string;
  mime?: string;
  extension?: string;
  url: string;
  is_public?: boolean;
  temp?: boolean;
  workspace_id?: string;
  created_date?: string;
  expire_at?: string; // set when temp: true
}
```

## `upload` example

```typescript
import { resource } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const uploaded = await resource.upload({
    file: input.fileBase64, // a base64 string is the simplest choice - see the type/caveats below
    name: 'export.csv',
    mime: 'text/csv',
    is_public: false,
    temp: false,
  });

  return { status: 'success', data: uploaded }; // uploaded.url is the file's accessible URL
}
```

## `remove` example

```typescript
import { resource } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  await resource.remove({ url: input.previousFileUrl });

  return { status: 'success' };
}
```

## Notes & caveats

- `file` accepts exactly three shapes, verified against the backend's real `toBuffer()` normalizer
  in `ResourceSDK.ts`: a base64-encoded string, a `{type:'Buffer',data:number[]}` object (this is
  what `JSON.stringify(someBuffer)` itself produces — `Buffer` has a custom `toJSON()`), or a plain
  `number[]` array of byte values. **A raw `Buffer` instance passed directly will NOT arrive
  correctly** — the call travels as JSON over gRPC, and a `Buffer` only survives that round-trip in
  one of the three shapes above (in practice, `JSON.stringify(buffer)` already produces the
  `{type:'Buffer',...}` shape for you, so `file: someBuffer` often works by accident via that
  implicit stringification — but pass it explicitly rather than relying on that).
- `temp: true` **is confirmed** to mark the upload for automatic deletion after a period of time —
  the returned `ResourceMeta.expire_at` reflects when. `is_public` **is confirmed** to control URL
  accessibility — default `false` (private); the file is only publicly reachable if you explicitly
  pass `is_public: true`.
- `workspace_id` is accepted but undocumented in most call sites — omit it and the backend falls
  back to `ctx.workspace`; only pass it explicitly if this invocation has no workspace attached.
- `upload` returns a typed `ResourceMeta` (see above) — `url` is what you pass back into `remove()`.
  `remove` itself still returns `Promise<any>` — no confirmed response shape, treat the resolved
  value as advisory (the removal already happened by the time the promise settles).
- There is no `resource.get`/`resource.list` — this namespace only uploads and removes. For
  workspace document records with listing/search, use `file.*` (`docs/sdk/file.md`) instead.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
