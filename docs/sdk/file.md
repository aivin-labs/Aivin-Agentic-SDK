# 📄 `file` — workspace document records (create, read, delete, list, search)

The `file` namespace manages workspace-level document records — the higher-level counterpart to
`resource`'s raw blob storage. Use it when you need a listable, searchable record for a document
(with whatever metadata your `createFile` payload includes), not just bytes-in-bytes-out. If you
only need to store/retrieve raw content by URL, see `resource.md` instead; if you actually need
both (upload a blob, then register it as a file), you'll typically call `resource.upload` first
and pass the resulting URL/metadata into `file.create`.

## Import

```typescript
import { file } from '@aivin-labs/sdk';
// legacy (works, not recommended): ctx.sdk.file
```

## Methods

| Method | Parameters | Returns | Description |
| --- | --- | --- | --- |
| `create(fileData)` | `fileData: Record<string, any>` | `Promise<any>` | Create a file record. `fileData` is passed through as-is — no fixed schema enforced client-side. |
| `get(id)` | `id: string` | `Promise<any>` | Fetch a file record by ID. |
| `del(id)` | `id: string` | `Promise<any>` | Delete a file record by ID. |
| `list(params?)` | `params?: { limit?: number; offset?: number }` | `Promise<any[]>` | List file records, paginated. |
| `search(query, opts?)` | `query: string, opts?: { file_ids?: string[]; limit?: number }` | `Promise<any[]>` | Search file records; optionally restrict to a specific set of `file_ids`. |

Underlying host calls: `file.createFile`, `file.getFile`, `file.deleteFile`, `file.listFiles`,
`file.searchFiles`.

## `create` example

```typescript
import { file } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const created = await file.create({
    name: 'invoice-2026-07.pdf',
    url: input.uploadedUrl, // e.g. the URL returned by resource.upload
    mime: 'application/pdf',
    workspace_id: ctx.workspace.id,
  });

  return { status: 'success', data: created };
}
```

## `get` / `del` example

```typescript
import { file } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const record = await file.get(input.fileId);
  if (!record) {
    return { status: 'error', message: 'File not found' };
  }

  if (input.shouldDelete) {
    await file.del(input.fileId);
  }

  return { status: 'success', data: record };
}
```

## `list` / `search` example

```typescript
import { file } from '@aivin-labs/sdk';

export async function main(mission, input, ctx) {
  const page = await file.list({ limit: 20, offset: 0 });

  const matches = await file.search('quarterly report', {
    file_ids: page.map((f) => f.id),
    limit: 5,
  });

  return { status: 'success', data: { page, matches } };
}
```

## Notes & caveats

- `create(fileData)` takes a single free-form `Record<string, any>` — there is no fixed, documented
  schema enforced at the SDK layer. Whatever fields the backend's `file.createFile` handler expects
  (name, url, mime, workspace scoping, etc.) must be supplied by the caller; the SDK does not
  validate or default them.
- `get`/`del` take a plain `id: string`, internally sent as `{ file_id: id }` — note the parameter
  name change between the client-facing method and the wire call.
- `list`/`search` both return `Promise<any[]>` — no typed record shape is available; treat entries
  as opaque objects and read fields defensively.
- `search`'s `opts.file_ids` scopes the search to a specific set of files rather than searching the
  whole workspace — useful for "search within these results" flows (e.g. chained off a prior
  `list()` call, as in the example above).
- This namespace is distinct from `resource` (raw blob upload/remove) and from `attachment.*`
  (AI-driven analysis over documents like `deepResearch`/`evaluate`/`queryTabularData`) — `file` is
  the plain CRUD+search layer for document records.

## See also

- [SDK Reference](../SDK.md) — the full SDK surface
- [README](../../README.md#what-the-sdk-exposes) — SDK overview
