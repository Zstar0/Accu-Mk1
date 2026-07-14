# Packaging photo order fan-out + QR phone capture — Design

**Date:** 2026-07-13
**Status:** Approved (Handler, 2026-07-13)
**Scope:** Accu-Mk1 only. Fully additive. No IS/COA/WP changes, no JWT_SECRET involvement.

## Problem

1. A packaging (box) photo taken during an order check-in belongs to the whole
   order, but today it lands on exactly one parent sample. Techs must re-shoot
   (or techs simply don't) for the other samples in the order.
2. The desktop webcam is often a poor tool for photographing a shipping box.
   Techs have phones with far better cameras, but no path from phone to Mk1.

An order *entity* that owns packaging photos is the eventual home (Handler,
2026-07-13); it does not exist yet. This design fans photos out to the order's
samples now, in a shape that migrates cleanly later.

## Decisions (locked with Handler)

- Fan-out is **automatic** whenever the wizard runs inside an order session;
  copies are **independent rows** per sample (edit/delete one sample's copy
  never touches siblings; late-added samples don't backfill).
- Phone capture is **packaging photos only** — vials keep the in-place camera.
- Phone shots follow the **same order-wide fan-out**; no sample picker on the
  phone. Standalone (single-sample) wizard scopes the QR to that one sample.
- Desktop must show phone shots **within a couple of seconds, no refresh**.
  Retake = delete on desktop, shoot again from phone.
- Phone auth = **scoped capture token in the QR** (option A), ~2 h TTL.
  No login on the phone.

## 1. Data model (additive)

### New table `lims_capture_tokens`

| column | type | notes |
|---|---|---|
| `id` | int PK | |
| `token_hash` | text, unique index | SHA-256 hex of the raw token; raw token is never stored |
| `order_label` | text nullable | display only, e.g. `WP-4478` |
| `context_json` | text (JSON) | frozen at mint: `[{"sample_id","lot","analytes"}]` — the phone page's display context AND the authoritative fan-out list |
| `created_by_user_id` | int FK users | minting user; every upload is attributed to them |
| `created_at` | datetime UTC | |
| `expires_at` | datetime UTC | mint + 2 h (`CAPTURE_TOKEN_TTL_HOURS = 2`) |
| `revoked_at` | datetime UTC nullable | set by DELETE endpoint |

### `lims_packaging_photos` — one new nullable column

- `capture_token_id` int FK `lims_capture_tokens.id` nullable — provenance
  ("came from that phone session") + powers the phone page's session photo
  count. Desktop-created photos leave it NULL.

Migration: `create_all` picks up the new table; the new column ships as the
usual hand-rolled idempotent `ALTER TABLE`. Nothing existing changes shape.
When the order entity lands, fan-out duplicates group naturally (same
`capture_token_id`, or same bytes/created_at cluster for desktop bulk rows).

## 2. Backend

### New service function — `packaging_photos/service.py`

```
create_packaging_photos_bulk(
    db, parent_sample_ids, photo_bytes, filename, content_type, remarks,
    user_id, capture_token_id=None,
) -> list[LimsPackagingPhoto]
```

- Resolves **all** parents first; any missing → `LookupError` naming the
  missing IDs, nothing written (fail-fast, all-or-nothing).
- Saves one storage object per parent (`{parent_sample_id}/{uuid}.{ext}` —
  the existing per-sample key convention, so per-sample edit/delete logic is
  untouched). Bytes are deliberately duplicated per sample; photos are a few
  hundred KB, orders have ≤ ~10 samples.
- `ordering = max+1` computed per parent, all rows inserted, **single commit**.
- On storage failure midway: best-effort delete of already-saved keys
  (`_delete_stored_photo_quietly`), raise; no rows committed.
- The single-sample `create_packaging_photo` stays; bulk with one ID is
  equivalent but existing callers/tests remain untouched (additive rule).

### New module `capture_tokens/` (service + routes + schemas)

Follows the `packaging_photos/` module shape.

JWT-authed (desktop) routes:

- `POST /api/capture-tokens` — body
  `{samples: [{sample_id, lot, analytes}], order_label?}`.
  Validates every `sample_id` exists as a `LimsSample` (404 naming missing).
  Mints `secrets.token_urlsafe(32)`, stores the SHA-256, returns
  `{id, token, expires_at}` — the **only** time the raw token leaves the
  server. Cap: refuse > 50 samples (sanity).
- `DELETE /api/capture-tokens/{id}` — sets `revoked_at` (idempotent 204).
  The desktop's kill switch if a QR leaks.

Token-authed (phone, no session) routes — lookup is by
`sha256(token_from_path)` against the unique index:

- `GET /api/capture/{token}` → `{order_label, samples, photo_count,
  expires_at}` where `photo_count` counts `lims_packaging_photos` rows with
  this `capture_token_id` **divided by the sample count** (i.e., shots this
  session, not rows). Unknown token → 404; expired or revoked → **410**.
- `POST /api/capture/{token}/photos` — body `{photo_base64}` (base64 JSON,
  matching every existing photo boundary in this repo; the phone page gets
  base64 natively from `canvas.toDataURL`). Guards, in order: token valid
  (404/410 as above), decoded size ≤ **10 MB** (413), magic bytes must sniff
  as jpeg/png/webp (415 — reuse `_filename_from_bytes` sniffing), shots this
  token < **50** (429). Then delegates to `create_packaging_photos_bulk` with
  `parent_sample_ids` from `context_json`, `user_id` = minting user,
  `capture_token_id` set, filename from magic-byte sniff. Returns
  `{created, photo_count}`.

Router registration in `main.py` mirrors the packaging_photos include.

## 3. Frontend (desktop)

### API client (`src/lib/api.ts`)

- `createPackagingPhotosBulk({parentSampleIds, photoBase64, remarks})`
- `mintCaptureToken({samples, orderLabel}) → {id, token, expiresAt}`
- `revokeCaptureToken(id)`

### `PackagingPanel`

Two new optional props threaded from `OrderReceiveSession` →
`ReceiveWizard` → panel:

- `fanoutSampleIds?: string[]` — the order's parent sample IDs
  (`boxing.sampleIds` already exists on the wizard's props for the order flow).
- `captureContext?: {orderLabel: string | null, samples: [{sample_id, lot,
  analytes}]}` — for the QR mint (the order session already computes lot +
  analytes per row for its sidebar).

Save behavior: when `fanoutSampleIds` has > 1 entry, Save calls the bulk
endpoint and toasts "Photo added to N samples"; otherwise the existing single
endpoint (standalone path byte-identical to today). After save, invalidate
`['packaging-photos', id]` for every fan-out ID.

### New `CaptureQrCard` (ReceiveWizard/)

- Renders inside PackagingPanel's live-capture column (both order and
  standalone flows). In the order flow `OrderReceiveSession` supplies the
  context; in the standalone flow `ReceiveWizard` builds a one-sample context
  from `useParentSampleDetails` (lot = client lot, analytes joined) — both
  arrive through the same `captureContext` prop.
- Mints a token on first render (per panel mount), renders
  `<QRCodeSVG value={`${window.location.origin}/m/capture.html?t=${token}`}>`
  with caption "Scan with your phone to add box photos" and a subtle expiry
  note. Mint failure → card collapses to nothing (QR is an enhancement; the
  desktop camera is unaffected).
- Token is NOT revoked on unmount (tab switches would churn tokens; TTL
  covers cleanup). Kept in component state; remount = new token, which is fine.

### Live sync

The packaging photo **list query** gets `refetchInterval: 2500` while the
packaging tab is mounted (the query lives with the list; polling stops when
the tab unmounts). New rows appear as new IDs; thumbnail byte queries fetch
once per ID as today. No SSE — avoids the double-nginx unbuffered-location
requirement for a screen that's only open minutes at a time.

## 4. Phone page — `public/m/capture.html`

Self-contained static page (same serving pattern as `public/guides/*.html`);
mobile viewport; dark-scheme aware; zero SPA/auth involvement.

- Reads `t` from the query string. `GET /api/capture/{t}` → renders Order #,
  sample rows (ID / Lot / Analytes), session photo count.
- Big **Take photo** button = `<label>` over
  `<input type="file" accept="image/*" capture="environment">` → native
  camera app (more reliable on mobile browsers than in-page getUserMedia).
- Each shot: draw to canvas (max edge 2000 px) → `toDataURL('image/jpeg',
  0.85)` → normalizes iPhone HEIC + caps upload at a few hundred KB → POST.
  Success: thumbnail strip + count update. Failure: shot retained in page
  state with a Retry button.
- 404/410 → full-page "This QR has expired — reopen the packaging tab on the
  desktop to get a fresh one."
- The resize/encode helper lives in `public/m/capture.js` next to the page so
  the HTML stays readable; both are plain files copied by Vite's `public/`
  passthrough.

**Frontend nginx** (in-repo `nginx.conf` baked into the frontend image): add
`/m/` HTML to the existing no-cache location treatment so page updates ship
with deploys (assets under `/assets/` stay immutable; this page is tiny).

## 5. Security

- Token: 256-bit `token_urlsafe`, stored **hashed** (DB leak exposes nothing
  live), 2 h TTL, revocable, scope frozen at mint to a sample list, usable
  only for: read frozen context, add packaging photos. No reads of other
  data, no deletes, no edits.
- Exposure if the QR is photographed off-screen: attacker can add packaging
  photos to that one order for ≤ 2 h, every one attributed to the minting
  user and flagged with the token id — visible, auditable, deletable.
- Upload guards: 10 MB size cap, magic-byte content sniffing (same
  stored-XSS defense as the existing serving route), 50-shot token cap.
- EXIF (phone GPS) is retained today — packaging photos are internal-only.
  Future hardening item, out of scope.

## 6. ISO 17025 alignment

Packaging photos are technical records of received items (7.5) supporting
review of requests (7.1) and sample condition on receipt (7.4). This feature
strengthens attributability: phone-sourced records carry the minting user
(`created_by_user_id`) and session provenance (`capture_token_id`), and
records live in the same controlled storage (S3) as other photo records.
No record-retention behavior changes.

## 7. Testing

Backend (pytest, existing packaging test patterns):
- bulk service: row per parent, per-parent ordering, all-or-nothing on a
  missing parent, storage-cleanup on midway failure, `capture_token_id`
  stamped.
- token service: mint stores hash not token; validate happy path; expired →
  410 semantics; revoked → 410; unknown → 404.
- routes: mint validates sample existence + 50-sample cap; capture GET
  context + photo_count; capture POST happy path fans out to all samples;
  413 oversize; 415 bad magic bytes; 429 shot cap; bulk route (JWT) happy
  path + 404 on missing parent.

Frontend (vitest, existing panel test patterns):
- PackagingPanel: `fanoutSampleIds` > 1 → bulk client called with all IDs;
  absent → single endpoint (existing tests keep passing).
- CaptureQrCard: renders QR with minted token URL; mint failure renders
  nothing.
- Polling: packaging list query configured with `refetchInterval` on the
  packaging tab.

Phone page: manual UAT on an isolated stack (mint → scan → shoot → rows on
all samples → desktop list updates). The encode helper is exercised by the
UAT; no jsdom harness for the static page.

Gate: full-suite failure-set diff vs origin/master baseline (the standing
Mk1 gate), `tsc`, eslint/ast-grep/prettier parity, `npm run build`.

## 8. Rollout

Single Mk1 release (backend + frontend images). DB changes are additive and
auto-apply on boot. The phone flow needs nothing but the existing public
HTTPS domain. Order of ship: no cross-service ordering constraints.

Out of scope (deliberate): order entity, vial phone capture, SSE push,
per-sample phone targeting, EXIF stripping, token refresh on the phone.
