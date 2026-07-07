# Packaging Photos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Executed by **devbox `claude -p` workers** in `~/worktrees/Accu-Mk1-boxing` on branch `feat/order-first-checkin-boxing`; read the codebase for exact signatures where this plan says "mirror".

**Goal:** Capture Mk1-native "packaging" photos against the parent sample during check-in (and via the Manage Sub-Samples overlay), stored in the same S3-gated storage as vial photos, viewable read-only in Sample Details → Attachments.

**Architecture:** Additive. New `lims_packaging_photos` table + a `backend/packaging_photos/` module with 5 Mk1-only routes reusing the existing `PhotoStorage` layer. Frontend: a new first "Packaging" tab in `ReceiveWizard` (`PackagingPanel` + `PackagingImagesList`, clones of `VialPanel`/`VialsList`), an api-client set, and a read-only thumbnail group in `SampleDetails`.

**Tech Stack:** FastAPI + SQLAlchemy + pytest (backend); React 19 + TS + TanStack Query + shadcn/ui + Vitest (frontend). Spec: `docs/superpowers/specs/2026-06-30-packaging-photos-design.md`.

## Global Constraints

- **npm only** (frontend). Frontend gates: `npx tsc --noEmit`, `npx vitest run <scoped>`. Backend: pytest in-container.
- **Additive only.** No SENAITE changes; no change to existing vial/photo/wizard behavior. A failing existing test defaults to "stale test".
- **Path-limit every commit** (`git commit -- <files>`); never `git add -A`/`.`. **Never stage `vite.config.ts` or `package-lock.json`.**
- **LIMS tables use the `lims_` prefix** → `lims_packaging_photos`.
- **Storage:** reuse `PhotoStorage` (`backend/sub_samples/photo_storage.py`) — Filesystem default, `S3PhotoStorage` when `MK1_PHOTO_S3_BUCKET` is set. Key by **parent** `sample_id` → `{parent_sample_id}/{uuid}.{ext}`. Persist `mk1://<key>` in `storage_key` (same convention as vials' `photo_external_uid`).
- **Auth:** all routes `Depends(get_current_user)` (Bearer/JWT, `backend/auth.py`).
- **Backend layout:** Python under `backend/` (container `cd /app` == `backend/`). Install pytest first: `docker exec accumark-boxing-accu-mk1-backend sh -lc "cd /app && pip install -q pytest"`. Frontend container: `accumark-boxing-accu-mk1-frontend`.
- **4 known-failing frontend tests are stale** (`wordpress-url` ×2, `App.test`, `peptide-requests-list`) — ignore, never "fix". Prefer path-scoped vitest.
- Zustand: selector syntax only (never destructure the store).

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `backend/models.py` | Add `LimsPackagingPhoto` (so `create_all` registers the table) | 1 |
| `backend/packaging_photos/{__init__,service}.py` (new) | Storage-backed CRUD service | 1 |
| `backend/packaging_photos/{schemas,routes}.py` (new) | Pydantic schemas + 5 routes | 2 |
| `backend/main.py` | `include_router(packaging_photos.router)` (mirror how the boxes router is mounted) | 2 |
| `backend/tests/test_packaging_photos_{service,routes}.py` (new) | Tests | 1, 2 |
| `src/lib/api.ts` | `create/list/fetch/update/deletePackagingPhoto` | 3 |
| `src/components/intake/ReceiveWizard/PackagingImagesList.tsx` (new) | Gallery (clone `VialsList`) | 4 |
| `src/components/intake/ReceiveWizard/PackagingPanel.tsx` (new) | Capture (clone `VialPanel` minus Quantity/Assignment) | 5 |
| `src/components/intake/ReceiveWizard/ReceiveWizard.tsx` | Wire the `'packaging'` phase/tab/render | 6 |
| `src/components/senaite/SampleDetails.tsx` | Read-only Packaging thumbnails in Attachments | 7 |

---

## Task 1: Backend model + service

**Files:**
- Modify: `backend/models.py` (add `LimsPackagingPhoto` near `LimsSample`/`LimsSubSampleAttachment`)
- Create: `backend/packaging_photos/__init__.py`, `backend/packaging_photos/service.py`
- Test: `backend/tests/test_packaging_photos_service.py`

**Interfaces:**
- Produces (service, all take a `Session`):
  - `create_packaging_photo(db, parent_sample_id: str, photo_bytes: bytes, filename: str, content_type: str | None, remarks: str | None, user_id: int | None) -> LimsPackagingPhoto` — 404-equivalent `LookupError` if the parent `LimsSample` is unknown; assigns `ordering = max+1`; stores via `PhotoStorage`; `storage_key = "mk1://" + key`.
  - `list_packaging_photos(db, parent_sample_id: str) -> list[LimsPackagingPhoto]` (ordered by `ordering`).
  - `get_packaging_photo(db, photo_id: int) -> LimsPackagingPhoto | None`.
  - `read_packaging_photo_bytes(db, photo_id: int) -> tuple[bytes, str | None] | None` (bytes + content_type; strips `mk1://`).
  - `update_packaging_photo(db, photo_id, photo_bytes: bytes | None, remarks: str | None) -> LimsPackagingPhoto | None` (if bytes: save new, delete old key, swap `storage_key`).
  - `delete_packaging_photo(db, photo_id) -> bool` (delete storage + row).
- Consumes: `PhotoStorage` — read `backend/sub_samples/photo_storage.py` for the exact factory/singleton the sub_samples service uses (e.g. `get_photo_storage()`), and `save_photo(sample_id, bytes, filename) -> key` / `fetch_photo(key)` / `delete_photo(key)`.

- [ ] **Step 1: Add the model** to `backend/models.py`. Mirror the column idioms of `LimsSubSampleAttachment`/`LimsSample` (imports, `mapped_column`, `created_at` default, `ForeignKey`). Exact shape:
  ```python
  class LimsPackagingPhoto(Base):
      __tablename__ = "lims_packaging_photos"
      id: Mapped[int] = mapped_column(primary_key=True)
      parent_sample_pk: Mapped[int] = mapped_column(
          ForeignKey("lims_samples.id", ondelete="CASCADE"), index=True, nullable=False)
      kind: Mapped[str] = mapped_column(default="packaging")
      storage_key: Mapped[str] = mapped_column(nullable=False)
      filename: Mapped[Optional[str]] = mapped_column(nullable=True)
      content_type: Mapped[Optional[str]] = mapped_column(nullable=True)
      ordering: Mapped[int] = mapped_column(default=0)
      remarks: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
      created_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)  # match neighbours' idiom
      created_by_user_id: Mapped[Optional[int]] = mapped_column(
          ForeignKey("users.id"), nullable=True)
  ```
  (Use whatever `Text`/`datetime` imports the file already has; if `users` table pk differs, match it.)
- [ ] **Step 2: Write failing service tests** `backend/tests/test_packaging_photos_service.py` — mirror `test_boxes_service.py` for DB/session + storage setup (use the filesystem storage default with a tmp dir, or the same fixture the sub_samples/boxes tests use). Cover:
  ```python
  def test_create_assigns_incrementing_ordering_and_stores_bytes(db, parent_sample):
      p1 = create_packaging_photo(db, parent_sample.sample_id, b"a", "a.jpg", "image/jpeg", None, 1)
      p2 = create_packaging_photo(db, parent_sample.sample_id, b"bb", "b.jpg", "image/jpeg", "note", 1)
      assert p1.ordering == 0 and p2.ordering == 1
      assert p1.storage_key.startswith("mk1://")
      raw, ct = read_packaging_photo_bytes(db, p1.id)
      assert raw == b"a" and ct == "image/jpeg"
  def test_create_unknown_parent_raises(db):
      with pytest.raises(LookupError):
          create_packaging_photo(db, "NOPE", b"a", "a.jpg", "image/jpeg", None, 1)
  def test_list_ordered(db, parent_sample): ...
  def test_update_replaces_bytes_and_deletes_old_key(db, parent_sample): ...
  def test_delete_removes_row_and_storage(db, parent_sample): ...
  ```
- [ ] **Step 3: Run tests → FAIL:** `docker exec accumark-boxing-accu-mk1-backend sh -lc "cd /app && pip install -q pytest && python -m pytest tests/test_packaging_photos_service.py -q"`
- [ ] **Step 4: Implement** `backend/packaging_photos/service.py` per the Interfaces. Resolve the parent by `LimsSample.sample_id`; store with `storage.save_photo(parent_sample_id, photo_bytes, filename)`; compute `ordering` via `func.max`/a query; commit. `read_packaging_photo_bytes` strips the `mk1://` prefix before `fetch_photo`.
- [ ] **Step 5: Run tests → PASS.**
- [ ] **Step 6: Commit** (path-limited): `git commit -- backend/models.py backend/packaging_photos/__init__.py backend/packaging_photos/service.py backend/tests/test_packaging_photos_service.py -m "feat(packaging-photos): LimsPackagingPhoto model + storage-backed service"`

## Task 2: Backend schemas + routes

**Files:**
- Create: `backend/packaging_photos/schemas.py`, `backend/packaging_photos/routes.py`
- Modify: `backend/main.py` (mount the router)
- Test: `backend/tests/test_packaging_photos_routes.py`

**Interfaces:**
- Routes (all `Depends(get_current_user)`), mirror `backend/sub_samples/routes.py` for the FastAPI/session/error idioms:
  - `POST /api/samples/{parent_sample_id}/packaging-photos` — body `PackagingPhotoCreate { photo_base64: str, remarks: str | None = None, filename: str | None = None, content_type: str | None = None }`. Decode base64 (mirror how sub_samples decodes `photo_base64`), call `create_packaging_photo`, 404 on `LookupError`. Returns `PackagingPhotoOut`.
  - `GET /api/samples/{parent_sample_id}/packaging-photos` → `list[PackagingPhotoOut]`.
  - `GET /api/packaging-photos/{photo_id}` → `Response(content=bytes, media_type=content_type or "application/octet-stream")`; 404 if missing.
  - `PATCH /api/packaging-photos/{photo_id}` — body `PackagingPhotoUpdate { photo_base64: str | None = None, remarks: str | None = None }` → `PackagingPhotoOut`; 404 if missing.
  - `DELETE /api/packaging-photos/{photo_id}` → 204; 404 if missing.
- `PackagingPhotoOut { id: int, ordering: int, remarks: str | None, content_type: str | None, created_at: datetime, created_by_user_id: int | None }`.
- Router prefix: mirror the boxes router. Boxes uses prefix `/api/boxes`; here the two path shapes (`/api/samples/{id}/packaging-photos` and `/api/packaging-photos/{id}`) need a router with prefix `/api` (or two routers). Confirm by reading `backend/boxes/routes.py` (its `APIRouter(prefix=...)`) and `backend/main.py`'s `include_router(...)` for boxes, and match that registration style.

- [ ] **Step 1: Write failing route tests** `backend/tests/test_packaging_photos_routes.py` — mirror `test_boxes_routes.py` (TestClient + auth header/override). Cover: POST creates (200/201 + body); GET list returns ordered; GET bytes returns 200 + correct `content-type`; PATCH updates remarks; DELETE → 204 then GET bytes → 404; unauthenticated → 401/403; unknown parent POST → 404; unknown photo GET/PATCH/DELETE → 404.
- [ ] **Step 2: Run → FAIL:** `docker exec accumark-boxing-accu-mk1-backend sh -lc "cd /app && python -m pytest tests/test_packaging_photos_routes.py -q"`
- [ ] **Step 3: Implement** `schemas.py` + `routes.py`; mount in `backend/main.py` next to the boxes router (same include style). Base64 decode helper: reuse the same approach `sub_samples` uses (find it — likely `base64.b64decode`).
- [ ] **Step 4: Run → PASS.** Also re-run the service tests + `test_boxes_*` to confirm no regression: `... python -m pytest tests/test_packaging_photos_service.py tests/test_packaging_photos_routes.py tests/test_boxes_routes.py -q`
- [ ] **Step 5: Commit:** `git commit -- backend/packaging_photos/schemas.py backend/packaging_photos/routes.py backend/main.py backend/tests/test_packaging_photos_routes.py -m "feat(packaging-photos): 5 Mk1-only routes (create/list/bytes/patch/delete)"`

## Task 3: Frontend api client

**Files:**
- Modify: `src/lib/api.ts`

**Interfaces (mirror the sub-sample photo fns — `createSubSample`, `fetchSubSamplePhotoUrl`, `updateSubSample`):**
```ts
export interface PackagingPhoto { id: number; ordering: number; remarks: string | null; content_type: string | null; created_at: string; created_by_user_id: number | null }
export async function createPackagingPhoto(args: { parentSampleId: string; photoBase64: string; remarks?: string | null; filename?: string; contentType?: string }): Promise<PackagingPhoto>
export async function listPackagingPhotos(parentSampleId: string): Promise<PackagingPhoto[]>
export async function fetchPackagingPhotoUrl(photoId: number): Promise<string | null>   // blob-URL, cached (mirror fetchSubSamplePhotoUrl + its cache)
export async function updatePackagingPhoto(photoId: number, args: { photoBase64?: string; remarks?: string | null }): Promise<PackagingPhoto>
export async function deletePackagingPhoto(photoId: number): Promise<void>
```

- [ ] **Step 1: Implement** the 5 fns + `PackagingPhoto` type in `src/lib/api.ts`, mirroring the nearby sub-sample photo fns exactly (use `API_BASE_URL()` + `/api/...`, `getBearerHeaders()`, throw on non-2xx; for `fetchPackagingPhotoUrl` clone `fetchSubSamplePhotoUrl`'s blob → `URL.createObjectURL` + a module-level `Map` cache keyed by `photoId`, 404 → null).
- [ ] **Step 2: Verify** `docker exec accumark-boxing-accu-mk1-frontend sh -lc "cd /app && npx tsc --noEmit"` → 0 errors.
- [ ] **Step 3: Commit:** `git commit -- src/lib/api.ts -m "feat(api): packaging-photo client (create/list/fetch/update/delete)"`

## Task 4: PackagingImagesList (gallery)

**Files:**
- Create: `src/components/intake/ReceiveWizard/PackagingImagesList.tsx`
- Test: `src/components/intake/ReceiveWizard/__tests__/PackagingImagesList.test.tsx`

**Interfaces:**
```ts
interface PackagingImagesListProps { parentSampleId: string; onEdit?: (photo: PackagingPhoto) => void }
export function PackagingImagesList(props): JSX.Element
```
Read `src/components/intake/ReceiveWizard/VialsList.tsx` and mirror its structure/styling (the 240px right column). Uses `useQuery(['packaging-photos', parentSampleId], () => listPackagingPhotos(parentSampleId))`; each item renders a thumbnail via `fetchPackagingPhotoUrl(photo.id)` (mirror how `VialDetailsTab`/`VialsList` resolves photo urls), shows `remarks`, a delete button (`deletePackagingPhoto` → invalidate `['packaging-photos', parentSampleId]`), and calls `onEdit(photo)` on click. Header "Packaging Images".

- [ ] **Step 1: Write failing test** (mock `@/lib/api`): renders one item per photo returned by `listPackagingPhotos`; clicking delete calls `deletePackagingPhoto`; header reads "Packaging Images".
- [ ] **Step 2: Run → FAIL:** `docker exec accumark-boxing-accu-mk1-frontend sh -lc "cd /app && npx vitest run src/components/intake/ReceiveWizard/__tests__/PackagingImagesList.test.tsx"`
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run → PASS; `tsc` 0 errors.**
- [ ] **Step 5: Commit:** `git commit -- src/components/intake/ReceiveWizard/PackagingImagesList.tsx src/components/intake/ReceiveWizard/__tests__/PackagingImagesList.test.tsx -m "feat(packaging-photos): PackagingImagesList gallery"`

## Task 5: PackagingPanel (capture)

**Files:**
- Create: `src/components/intake/ReceiveWizard/PackagingPanel.tsx`
- Test: `src/components/intake/ReceiveWizard/__tests__/PackagingPanel.test.tsx`

**Interfaces:**
```ts
interface PackagingPanelProps { parentSampleId: string; editing?: PackagingPhoto | null; onSaved?: () => void; onCancelEdit?: () => void }
export function PackagingPanel(props): JSX.Element
```
Clone `src/components/intake/ReceiveWizard/VialPanel.tsx`'s camera (`getUserMedia`) + Choose-file + Remarks + Save UI, **removing Quantity and Assignment** and any vial-specific bulk logic. Reuse `dataUrlToBytes` + `bytesToBase64` (import/lift them). On Save (create): `createPackagingPhoto({ parentSampleId, photoBase64, remarks })` then invalidate `['packaging-photos', parentSampleId]` + clear the form + `onSaved?.()`. On Save while `editing` set: `updatePackagingPhoto(editing.id, { photoBase64?, remarks })`. Photo is required on create; on edit, remarks-only edits allowed (no new photo). Heading "New packaging photo for {parentSampleId}" / "Edit packaging photo".

- [ ] **Step 1: Write failing test** (mock `@/lib/api` + `navigator.mediaDevices`): providing a photo (via the file-input path) + Save calls `createPackagingPhoto` with a base64 string; in `editing` mode Save calls `updatePackagingPhoto(editing.id, …)`; no Quantity field is rendered.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** per Interfaces (start from a copy of VialPanel; strip Quantity/Assignment/bulk).
- [ ] **Step 4: Run → PASS; `tsc` 0 errors.**
- [ ] **Step 5: Commit:** `git commit -- src/components/intake/ReceiveWizard/PackagingPanel.tsx src/components/intake/ReceiveWizard/__tests__/PackagingPanel.test.tsx -m "feat(packaging-photos): PackagingPanel capture (create + edit/retake)"`

## Task 6: Wire the Packaging tab into ReceiveWizard

**Files:**
- Modify: `src/components/intake/ReceiveWizard/ReceiveWizard.tsx`
- Test: extend/create `src/components/intake/ReceiveWizard/__tests__/ReceiveWizard.test.tsx` (or a focused test) — the Packaging tab renders first and shows the panel + list.

**Interfaces:** consumes `PackagingPanel`, `PackagingImagesList`; local `editingPackaging` state to link list→panel edit.

- [ ] **Step 1: Write a failing test** asserting a `Packaging` tab trigger exists and is the FIRST trigger, and selecting it renders `PackagingPanel` + `PackagingImagesList` (mock those two to sentinels).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement the 3 edits:**
  - `type Phase = 'packaging' | 'capture' | 'assign' | 'print' | 'details'` and set `initialPhase` handling so default is unchanged for existing callers (keep opening on `'capture'` unless a caller opts into `'packaging'`; simplest: leave `initialPhase` default as today and just add the tab).
  - Add `<TabsTrigger value="packaging">Packaging</TabsTrigger>` as the FIRST trigger in the `<TabsList>`.
  - Add, before the `phase === 'capture'` branch:
    ```tsx
    if (phase === 'packaging') {
      body = (
        <div className="grid grid-cols-[1fr_240px] min-h-0 overflow-hidden">
          <PackagingPanel parentSampleId={parent.sample_id} editing={editingPackaging}
            onSaved={() => setEditingPackaging(null)} onCancelEdit={() => setEditingPackaging(null)} />
          <PackagingImagesList parentSampleId={parent.sample_id} onEdit={setEditingPackaging} />
        </div>
      )
    }
    ```
  - The Packaging tab is always enabled (not gated on vials).
- [ ] **Step 4: Run → PASS; `tsc` 0 errors; `npx vitest run src/components/intake/ReceiveWizard`.**
- [ ] **Step 5: Commit:** `git commit -- src/components/intake/ReceiveWizard/ReceiveWizard.tsx src/components/intake/ReceiveWizard/__tests__/ReceiveWizard.test.tsx -m "feat(packaging-photos): Packaging tab (first) in ReceiveWizard"`

## Task 7: Read-only Packaging thumbnails in SampleDetails Attachments

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx`
- Test: a focused test that the packaging group renders when `listPackagingPhotos` returns rows.

**Interfaces:** reuse `listPackagingPhotos` + `fetchPackagingPhotoUrl`. Read the Attachments section of `SampleDetails.tsx` (around `AttachmentImage` / `ATTACHMENT_TYPES`, ~lines 826, 1162) and add a **read-only** "Packaging" subgroup styled like the existing `AttachmentImage` thumbnails. No upload/edit/delete controls here. Query keyed `['packaging-photos', parentSampleId]` (shares cache with the wizard).

- [ ] **Step 1: Write failing test** — with `listPackagingPhotos` mocked to return rows, the SampleDetails Attachments area renders a "Packaging" group with a thumbnail per row and no delete/edit buttons.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the read-only group (small presentational component inside SampleDetails, or a tiny local `PackagingThumb`).
- [ ] **Step 4: Run → PASS; `tsc` 0 errors.**
- [ ] **Step 5: Commit:** `git commit -- src/components/senaite/SampleDetails.tsx <test file> -m "feat(packaging-photos): read-only Packaging thumbnails in SampleDetails Attachments"`

---

## Self-review (plan author)

- **Spec coverage:** table (T1) · storage reuse (T1) · 5 routes (T2) · api client (T3) · gallery (T4) · capture w/ edit+retake (T5) · wizard tab first, serves check-in + Manage-Sub-Samples overlay since it's the same component (T6) · read-only Attachments group (T7) · attribution `created_by_user_id` (T1 model + T2 POST) · no-hard-cap (no cap anywhere) · capture doesn't trigger receive (T5/T6 never call receive). All spec sections mapped.
- **Type consistency:** `PackagingPhoto` (T3) consumed by T4/T5/T7; service fn names (T1) consumed by routes (T2); `parentSampleId` prop threaded T4/T5/T6/T7; query key `['packaging-photos', parentSampleId]` shared T4/T6/T7.
- **Open reads for the worker (exact-signature lookups, not placeholders):** the `PhotoStorage` factory/singleton + method names in `photo_storage.py`; how `sub_samples` decodes `photo_base64`; the boxes router prefix + `include_router` style in `main.py`; `VialsList`/`VialPanel` internals to clone; `dataUrlToBytes`/`bytesToBase64` locations; the SampleDetails Attachments markup around `AttachmentImage`.
- **Verification:** backend pytest (service+routes, install pytest first) — also run `test_boxes_routes` to confirm no router-mount regression; frontend `tsc` + path-scoped vitest per task.
