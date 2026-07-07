# Packaging Photos · Design

*Created 2026-06-30. Branch: `feat/order-first-checkin-boxing`. Status: approved, ready for implementation plan.*

## Context

Staff should be able to capture **package photos** (the shipping package and its contents) against the
**parent sample** during check-in — a new photo type **`packaging`**, distinct from SENAITE's
"Sample Image" / "Chromatograph". These live **only in Accu-Mk1** (the lab is weaning off SENAITE), stored
through the **same S3-gated storage as vial images**. This is additive: nothing touches SENAITE and no
existing photo/vial behavior changes.

Investigation confirmed the key reuse points:
- Tabs live inline in `src/components/intake/ReceiveWizard/ReceiveWizard.tsx` as a string-union `Phase`.
- `SampleDetails.tsx` opens the **same `ReceiveWizard`** via its "Manage Sub-Samples" button (import at
  `:114`, render at `:5177`). So a Packaging tab added to the wizard appears in **both** the check-in flow
  and the Manage Sub-Samples overlay automatically, with full capability.
- Photo storage is a transport-agnostic `PhotoStorage` protocol (`backend/sub_samples/photo_storage.py`):
  `FilesystemPhotoStorage` (default) / `S3PhotoStorage` (when `MK1_PHOTO_S3_BUCKET` is set), key
  `{sample_id}/{uuid}.{ext}`, DB stores `mk1://<key>`.
- `VialPanel.tsx` owns the camera + Choose-file + remarks + Save capture UX (`dataUrlToBytes`), reusable
  nearly verbatim (drop Quantity/Assignment).
- "packaging" is the **first Mk1-native parent photo type** — no existing enum/model to extend; nothing in
  SENAITE to fight.

## Surfaces

1. **Check-in wizard** — a new **Packaging** tab, placed FIRST (before Vial Management). Capture-left /
   gallery-right (reuses the `grid grid-cols-[1fr_240px]` layout). Full add / edit (retake + remarks) /
   delete. No hard cap on count.
2. **Manage Sub-Samples overlay** (Sample Details page) — the same wizard, so the Packaging tab appears
   there with the same full capability. No separate management UI is built.
3. **Sample Details → Attachments section** — **read-only** Packaging thumbnails for at-a-glance viewing,
   alongside the existing SENAITE attachments. All add/edit/delete happens in the wizard overlay, not here.

---

## Data model — new table `lims_packaging_photos` (additive)

```python
class LimsPackagingPhoto(Base):
    __tablename__ = "lims_packaging_photos"
    id: Mapped[int] = mapped_column(primary_key=True)
    parent_sample_pk: Mapped[int] = mapped_column(
        ForeignKey("lims_samples.id", ondelete="CASCADE"), index=True, nullable=False)
    kind: Mapped[str] = mapped_column(default="packaging")   # reserved for future types
    storage_key: Mapped[str]                                  # 'mk1://<key>' (same locator as vials)
    filename: Mapped[Optional[str]]
    content_type: Mapped[Optional[str]]
    ordering: Mapped[int] = mapped_column(default=0)          # next-per-parent, gallery order
    remarks: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(default=utcnow-ish, per existing models)
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id"), nullable=True)               # attribution (ISO 17025 §7.5.1)
```

- No change to `lims_samples` / `lims_sub_samples`. As a brand-new table it is created by Mk1's
  `Base.metadata.create_all` on startup (Mk1 uses create_all + hand-rolled idempotent ALTERs; a new table
  needs no ALTER). Match the exact column/`created_at` idioms of the neighbouring models (e.g.
  `LimsSubSampleAttachment`) rather than the pseudo-types above.
- **Ordering** is assigned server-side as `max(ordering)+1` for the parent at insert.

## Storage (identical model to vials)

Reuse `PhotoStorage` unchanged: `storage.save_photo(parent_sample_id, bytes, filename) -> key`,
`fetch_photo(key)`, `delete_photo(key)`. Keyed by **parent** `sample_id` → `{parent_sample_id}/{uuid}.{ext}`.
Persist `mk1://<key>` in `storage_key` (same convention as vials' `photo_external_uid`). Same bucket/prefix,
same `MK1_PHOTO_S3_BUCKET` gating — no separate storage path or config.

## Backend routes (Mk1-only, Bearer auth, mirror `backend/sub_samples/routes.py`)

Create a focused module `backend/packaging_photos/` (`routes.py`, `service.py`, `schemas.py`) mirroring the
`sub_samples` / `boxes` module shape. All routes `Depends(get_current_user)`.

- `POST /api/samples/{parent_sample_id}/packaging-photos` — body `{ photo_base64: str, remarks?: str,
  filename?: str, content_type?: str }`. Resolve the parent `LimsSample` (404 if unknown), decode base64,
  `storage.save_photo(parent_sample_id, bytes, filename)`, insert a row (`kind="packaging"`, next `ordering`,
  `created_by_user_id=current_user.id`), return the created row (id, ordering, remarks, created_at,
  created_by).
- `GET /api/samples/{parent_sample_id}/packaging-photos` — list rows for the parent, ordered by `ordering`
  (id, ordering, remarks, content_type, created_at, created_by). Feeds both the wizard gallery and the
  read-only Attachments thumbnails.
- `GET /api/packaging-photos/{photo_id}` — `storage.fetch_photo(strip 'mk1://' from storage_key)` →
  `Response(content=bytes, media_type=content_type)`. **No SENAITE fallback** (Mk1-only). 404 if missing.
- `PATCH /api/packaging-photos/{photo_id}` — `{ photo_base64?: str, remarks?: str }`. If `photo_base64`
  present, save new bytes + `delete_photo` the old key + update `storage_key`; update `remarks` if present.
  (Retake / edit.)
- `DELETE /api/packaging-photos/{photo_id}` — `storage.delete_photo` + delete the row.

## Frontend

- **`ReceiveWizard.tsx`** (3 edits): `type Phase` gains `'packaging'`; add a **first**
  `<TabsTrigger value="packaging">Packaging</TabsTrigger>`; add a render branch **before** `'capture'`:
  ```tsx
  if (phase === 'packaging') {
    body = (
      <div className="grid grid-cols-[1fr_240px] min-h-0 overflow-hidden">
        <PackagingPanel parentSampleId={parent.sample_id} … />
        <PackagingImagesList parentSampleId={parent.sample_id} … />
      </div>
    )
  }
  ```
- **`PackagingPanel`** (new; clone `VialPanel` minus Quantity + Assignment): camera (`getUserMedia`) +
  Choose-file fallback + Remarks + Save; **edit mode** (retake + edit remarks) mirroring `VialPanel`'s
  `onSaveEdit`. Reuse `dataUrlToBytes` + `bytesToBase64`. Save → `createPackagingPhoto`; edit →
  `updatePackagingPhoto`. Clears for the next shot after save (no bulk/multi-select).
- **`PackagingImagesList`** (new; clone `VialsList`): thumbnails via `listPackagingPhotos` +
  `fetchPackagingPhotoUrl` (blob-cache like `fetchSubSamplePhotoUrl`); each item shows remarks, click →
  edit in the panel, plus a delete control (`deletePackagingPhoto`).
- **`src/lib/api.ts`** — `createPackagingPhoto({ parentSampleId, photoBase64, remarks })`,
  `listPackagingPhotos(parentSampleId)`, `fetchPackagingPhotoUrl(photoId)` (blob-URL cache),
  `updatePackagingPhoto(photoId, { photoBase64?, remarks? })`, `deletePackagingPhoto(photoId)`. Mirror the
  sub-sample photo fns (reuse `getBearerHeaders`, `API_BASE_URL`, blob cache).
- **`SampleDetails.tsx`** Attachments section — a **read-only** "Packaging" group rendering the parent's
  packaging thumbnails (`listPackagingPhotos` + `fetchPackagingPhotoUrl`), styled like the existing
  `AttachmentImage` items. No upload/edit/delete here.

## Behavior notes

- Capturing a packaging photo **does not** trigger the SENAITE receive transition — it only needs the parent
  `LimsSample` row, which the wizard already ensures on open (`ensureParentSampleRow`). Independent of the
  vial-driven receive.
- The Packaging tab is enabled always (not gated on vials) since packaging is captured before/independent of
  vials.

## ISO 17025 alignment

Each packaging photo records **who captured it and when** (`created_by_user_id`, `created_at`) — attribution
per §7.5.1, on Mk1-native traceable records. Edits (retake) replace bytes in place; deletes remove the row —
these are operational capture aids at/after check-in, not test-result records. Locking edits/deletes once the
sample is verified/published is a possible future hardening (out of scope here).

## Testing

- **Backend** (`backend/tests/test_packaging_photos_*.py`, mirror `test_sub_samples`/`test_boxes`): table
  creation; POST creates a row + stores bytes (assert `ordering` increments per parent); GET list ordered;
  GET bytes returns correct `content_type`; PATCH replaces bytes + old key deleted / updates remarks; DELETE
  removes row + storage; 404s; Bearer auth required.
- **Frontend**: `PackagingPanel` Save sends base64 via `createPackagingPhoto` (and edit via
  `updatePackagingPhoto`); `PackagingImagesList` renders thumbnails from `listPackagingPhotos`; `ReceiveWizard`
  shows the Packaging tab first; `SampleDetails` Attachments renders the read-only packaging group.

## Reuse map (no changes needed)

`PhotoStorage` (filesystem + S3, env gating), backend base64/decode helpers, `get_current_user` auth, the
bytes-`Response` proxy pattern; frontend `dataUrlToBytes` / `bytesToBase64` / `getBearerHeaders` / the
blob-URL photo cache / the camera+canvas capture machinery / the `grid grid-cols-[1fr_240px]` layout.

## Out of scope (YAGNI)

- Customer-facing (WooCommerce / WP order gallery) surfacing of packaging photos — deferred; a separate
  follow-up (the vial-photo → WP gallery is itself still in progress).
- Multiple packaging sub-types / a type picker — single `kind="packaging"`; the `kind` column is reserved.
- Lock-on-publish for edits/deletes of packaging photos.
- Bulk capture / multi-select upload.
