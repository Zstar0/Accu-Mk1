# Vial photo center-square crop restore — Design

*2026-07-14. Approved scope: capture-side hotfix only (Mk1 v1.5.2).*

## Problem

The pre-rework Receive Sample page processed vial photos through
`src/components/intake/image-processing.ts` (`processVialPhoto`), which
center-cropped every capture to a square. The 2026-06-30 receive-page rework
replaced that flow with the `ReceiveWizard` overlay, whose capture
(`src/components/intake/ReceiveWizard/VialPanel.tsx`) draws the **full native
video frame** — no crop. Since then vial photos land widescreen (typically
4:3), which renders letterboxed-and-small in the COA's square image slot and
inconsistently across galleries.

Handler decisions (this session):

- Restore **only** the center-square crop at capture. No return of the old
  auto-enhance pass or the 500×496 downscale — full shorter-axis resolution
  stays (the photos feed the customer order-page gallery).
- **No coabuilder change, no S3 rewrite sweep, no COA regeneration.** Existing
  widescreen photos are handled manually by the Handler.

## Scope

Exactly two vial-photo entry points exist, both in `VialPanel.tsx`
(verified: the QR phone-capture page is packaging-photos-only by design, and
packaging captures deliberately stay full-frame 4:3):

1. **Webcam capture** — `capture` callback (`VialPanel.tsx` ~line 262).
   Currently `c.width = v.videoWidth; c.height = v.videoHeight;
   ctx.drawImage(v, 0, 0)`.
2. **File-picker fallback** — `onPickFile` (~line 295). Currently passes the
   raw file bytes through as a data URL, unprocessed.

## Design

### New helpers in `src/components/intake/image-processing.ts`

The legacy exports (`processVialPhoto`, `processFileImage`, `downscaleForCoa`)
are orphaned but stay untouched. Add two small functions:

- `captureSquareFromVideo(video, canvas, mimeType, quality): string` — computes
  `side = min(videoWidth, videoHeight)`, source-rect offsets
  `(vw−side)/2, (vh−side)/2`, sizes the canvas `side×side`, draws the cropped
  frame, returns `canvas.toDataURL(mimeType, quality)`. Throws on zero video
  dimensions (caller shows the existing "camera not ready" error).
- `cropFileToSquare(file, mimeType, quality): Promise<string>` — decodes the
  image file, center-crops to the shorter axis via canvas, re-encodes with the
  supplied format/quality. **If the image is already square (width ===
  height), resolves with the original file as a data URL — no re-encode**, so
  square uploads stay byte-identical. Rejects non-image files (same message
  contract as the old `processFileImage`).

### VialPanel changes

- `capture` calls `captureSquareFromVideo(v, c, captureMimeType(captureFormat),
  CAPTURE_JPEG_QUALITY)` instead of the inline full-frame draw. Error handling
  unchanged.
- `onPickFile` calls `cropFileToSquare(f, captureMimeType(captureFormat),
  CAPTURE_JPEG_QUALITY)` and stores the result. Decode failures surface via
  the existing `setLocalError` path.
- **Live-preview WYSIWYG:** the live `<video>` element (~line 525) changes
  from `aspect-[4/3] object-contain` to `aspect-square object-cover` so the
  operator sees exactly the region that will be saved. All *captured/existing*
  photo preview boxes stay `object-contain` — they must render legacy
  widescreen photos undistorted in edit mode.
- The `showGuides` overlay keeps working; guides remain visual-only.

### Untouched

Packaging capture (PackagingPanel, full-frame 4:3 by design), phone capture
page, Mk1 backend, photo storage, SENAITE upload, coabuilder, stored S3
objects, existing COA PDFs.

## Error handling

- Camera-not-ready and canvas-unavailable errors keep the exact current
  messages (moved behind the helper's thrown errors where applicable).
- File decode failure → `setLocalError` with a "not an image / failed to load"
  message; the picker can be retried.

## Testing

- Unit tests for both helpers (new `src/test/image-processing-square.test.ts`
  or colocated with existing patterns): crop geometry for landscape, portrait,
  and already-square inputs; square-input passthrough (no re-encode); format
  and quality forwarding; non-image rejection.
- Update `src/test/vial-panel-capture.test.tsx` for the new capture shape.
- Gate: targeted vitest suites + `npx tsc --noEmit` (full `check:all` is red
  on clean master — known repo-wide issue; judged by targeted suites per
  standing convention).

## ISO 17025 alignment

Vial check-in photos are objective evidence attached to test records. A
deterministic, documented capture geometry (fixed center-square) improves
record consistency; no metrological claims are made from photos, so no
validation impact beyond the documented UI behavior change.

## Ship

Mk1 frontend-only hotfix **v1.5.2** on `fix/vial-photo-square-crop` (branched
from `origin/master` @ 40d8737f). Deploy via the accumark-deploy skill; PR +
master reconcile + ancestor-verify immediately after; prod deploy gated on
Handler go.
