# 📦 `resource` — raw blob storage (upload / remove)

The `resource` namespace is the SDK's raw blob-storage primitive: upload arbitrary file content
and get back a stored object (typically including a URL), or remove a previously uploaded blob by
URL. It is deliberately minimal — two methods, no listing/searching/metadata management. Reach for
`file.*` instead when you want workspace-level document records (titles, search, listing); reach
for `resource` when you just need "put these bytes somewhere and get a URL back."

## Import

```typescript
import { resource } from '@aivin/sdk';
// equally: ctx.sdk.resource / import SDK from '@aivin/sdk'; SDK.resource
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `upload(params)` | `params: { file: any; name?: string; mime?: string; is_public?: boolean; temp?: boolean }` | `Promise<any>` | Upload a file blob to storage. |
| `remove(params)` | `params: { url: string }` | `Promise<any>` | Remove a previously uploaded blob by its URL. |

Underlying host calls: `resource.uploadFile`, `resource.removeFile`.

## `upload` example

```typescript
import { resource } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  const uploaded = await resource.upload({
    file: input.fileBuffer, // exact accepted shape (Buffer, base64 string, stream, etc.) is host-defined
    name: 'export.csv',
    mime: 'text/csv',
    is_public: false,
    temp: false,
  });

  return { status: 'success', data: uploaded };
}
```

## `remove` example

```typescript
import { resource } from '@aivin/sdk';

export async function main(mission, input, ctx) {
  await resource.remove({ url: input.previousFileUrl });

  return { status: 'success' };
}
```

## Notes & caveats

- The exact accepted type for `file` in `upload()` is typed as `any` in `SDKClient.ts` — the
  concrete shape the host expects (raw `Buffer`, base64-encoded string, a stream, a multipart form
  part, etc.) is **not confirmed** here; treat it as host-implementation-defined and verify against
  actual upload behavior before depending on a specific format.
- `name`, `mime`, `is_public`, and `temp` are all optional. `temp: true` presumably marks the
  upload for later cleanup/expiry, and `is_public: true` presumably affects URL accessibility, but
  neither behavior is spelled out beyond the parameter names in `SDKClient.ts` — confirm actual
  effect if it matters for your plugin's correctness.
- Both `upload` and `remove` return `Promise<any>` — no typed response shape is available; inspect
  the object at runtime (it likely includes at least a URL for `upload`, given `remove` takes a
  `url` to reverse it).
- There is no `resource.get`/`resource.list` — this namespace only uploads and removes. For
  workspace document records with listing/search, use `file.*` (`docs/sdk/file.md`) instead.

## See also

- [SDK Reference](../SDK.md) — the full `ctx.sdk` surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
