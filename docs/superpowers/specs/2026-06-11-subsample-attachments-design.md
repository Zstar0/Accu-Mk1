# Sub-Sample Image Attachments — Design

**Date:** 2026-06-11
**Status:** Approved
**Scope:** Vial (sub-sample) detail pages, e.g. `#senaite/sample-details?id=BW-0014-S01`

## Problem

Vial detail pages show the check-in photo in the header (`VialPhotoThumb`), but the
Attachments section is permanently empty: `buildNativeSubSampleLookup()` hardcodes
`attachments: []` and the SENAITE-bound `AddAttachmentForm` is hidden (no
`sample_uid`). Vials live only in Mk1, so there is nowhere to see the photo in the
attachments context, nor to add or remove additional sample images.

A latent bug compounds this: `service.update_sub_sample()` pushes a replacement
photo to SENAITE unconditionally (`senaite.upload_photo(sub.photo_external_uid, …)`)
— for native vials `photo_external_uid` is an `mk1://` storage key, not a SENAITE
attachment UID, so photo replace is broken for exactly the vials in scope.

## Decisions (user-approved)

1. **Vial photo is removable and replaceable** from the Attachments section. Header
   thumb updates immediately (disappears on remove).
2. **Extra images tracked in a new `lims_sub_sample_attachments` table** —
   metadata in Postgres, bytes in the existing `photo_storage.py` filesystem store.
3. **Images only** (png/jpg/jpeg/gif/webp/heic). Non-image files stay out of scope.

Additive only: no changes to existing tables, no SENAITE behavior changes for
legacy vials or parent pages.

## Backend

### New model: `LimsSubSampleAttachment` → `lims_sub_sample_attachments`

| column | type | notes |
|---|---|---|
| id | int PK | autoincrement |
| sub_sample_pk | int FK → lims_sub_samples.id | `ondelete=CASCADE` |
| storage_key | str | raw key into photo storage (no `mk1://` prefix) |
| filename | str | original upload filename |
| content_type | str | validated image/* |
| created_at | datetime | default utcnow |
| user_id | int FK → users.id, nullable | `ondelete=SET NULL` |

Created by the existing `create_all` mechanism — purely additive.

### New routes (existing `/api/sub-samples` router)

- `GET /{sample_id}/attachments` — list metadata (id, filename, content_type, created_at).
- `POST /{sample_id}/attachments` — body `{image_base64, filename}`; decodes at the
  boundary (reuses `_decode_photo`), validates extension/content-type against the
  image allowlist, saves via `photo_storage`, inserts row, writes
  `LimsSubSampleEvent(event='attachment_added')`.
- `GET /{sample_id}/attachments/{attachment_id}` — stream bytes with correct
  content type.
- `DELETE /{sample_id}/attachments/{attachment_id}` — delete row + storage file
  (file delete is idempotent), event `attachment_removed`.

### Vial photo remove + replace

- `DELETE /{sample_id}/photo` — **mk1-stored photos only**: delete the file, null
  `photo_external_uid`, event `photo_removed`. Legacy SENAITE-path photos → 409
  (the photo lives on the parent AR; not ours to delete).
- Replace reuses `PATCH /{sample_id}` with `photo_base64`. Fix in
  `update_sub_sample()`: when `photo_external_uid` starts with `mk1://` (or vial is
  native), save the new file, swap the key, delete the old file, event
  `photo_updated` — instead of calling `senaite.upload_photo` with an mk1 key.
  Legacy vials keep the SENAITE path.

## Frontend (SampleDetails.tsx, gated `parentSampleId !== null`)

The Attachments section on vial pages renders a Mk1-backed block (the SENAITE
attachment list/form remain as-is and are inert on these pages):

- **Vial Photo card** — same image as the header (`fetchSubSamplePhotoUrl`),
  badge "Vial Photo", buttons: Replace (file picker → PATCH) and Remove (confirm →
  DELETE photo). After change: invalidate `_subSamplePhotoCache` (new exported
  invalidate; seed on replace) and bump a `photoVersion` state used as `key` on the
  header `VialPhotoThumb` so it refetches. Also refresh the parent summary list so
  `photo_external_uid`-derived `hasPhoto` stays truthful.
- **Extra images** — responsive grid; each card: image preview (object URL via new
  fetch helper), filename, delete button (confirm). "Add Image" control mirroring
  `AddAttachmentForm` styling, `accept="image/*"`, posts base64 to the Mk1 route.
- **Header count** — `Attachments (N)` where N = (vial photo present ? 1 : 0) +
  extra image count on vial pages.

### New api.ts functions

`listSubSampleAttachments`, `uploadSubSampleAttachment`,
`fetchSubSampleAttachmentUrl` (object-URL cache like photos),
`deleteSubSampleAttachment`, `deleteSubSamplePhoto`,
`invalidateSubSamplePhoto(sampleId)`.

## Error handling

- Upload: non-image → 400; missing vial → 404; storage failure → 502.
- Delete attachment: missing row → 404; storage file already gone → still 204.
- Photo delete on legacy vial → 409 `{code: "photo_not_mk1"}`; FE hides Remove
  when `photo_external_uid` doesn't start with `mk1://`.

## Testing

Backend (pytest, patterns from `test_sub_samples_routes.py` / `test_photo_storage.py`):
upload→list→stream→delete roundtrip; images-only enforcement; photo delete nulls
key and removes file; native replace swaps key, deletes old file, never calls
SENAITE; legacy photo delete → 409; cascade delete of vial removes attachment rows.

Frontend: type/lint via `npm run check:all` path; manual UAT on BW-0014-S01.

## Out of scope

Parent (container) page attachments, non-image files, COA involvement, S3 storage.
