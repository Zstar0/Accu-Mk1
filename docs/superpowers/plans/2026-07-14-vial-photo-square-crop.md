# Vial Photo Center-Square Crop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore center-square cropping for vial photos in the ReceiveWizard overlay (both webcam capture and file-picker fallback), at full shorter-axis resolution, with a WYSIWYG square live preview.

**Architecture:** Two small framework-free helpers added to the existing (orphaned-but-kept) image module `src/components/intake/image-processing.ts`; `VialPanel.tsx` swaps its inline full-frame draw and raw file passthrough for those helpers; the live `<video>` preview becomes `aspect-square object-cover` so operators see exactly what is saved. No backend, no coabuilder, no storage changes.

**Tech Stack:** React + TypeScript, Canvas API, vitest + @testing-library/react (jsdom).

## Global Constraints

- Worktree: `C:\tmp\mk1-vial-square` (branch `fix/vial-photo-square-crop` off `origin/master` @ `40d8737f`). All commands run from this directory.
- npm ONLY (never pnpm). Do not run `npm install`; deps are already in place via `npm ci`.
- Full `npm run check:all` is red on clean master (known repo-wide issue) — the gate for this hotfix is: targeted vitest suites + `npx tsc --noEmit`.
- Keep full shorter-axis resolution — NO downscale, NO auto-enhance. JPEG quality stays `CAPTURE_JPEG_QUALITY` (0.9); the operator format toggle (`captureMimeType(captureFormat)`) keeps working.
- Existing error-message strings must be preserved exactly:
  - `'Camera not ready yet — try again in a moment.'`
  - `'Cannot capture — browser canvas unavailable.'`
- Packaging capture (`PackagingPanel.tsx`) stays full-frame 4:3 — do not touch it.
- The legacy exports in `image-processing.ts` (`processVialPhoto`, `processFileImage`, `downscaleForCoa`) stay untouched.
- jsdom has no canvas/image decoding: unit tests use duck-typed fakes and prototype mocks as shown; the file-decode happy path is manual-UAT only.

---

### Task 1: Pure crop geometry + video-capture helper

**Files:**
- Modify: `src/components/intake/image-processing.ts` (append new exports at end of file)
- Test: `src/test/image-processing-square.test.ts` (new)

**Interfaces:**
- Produces: `squareCropRect(width: number, height: number): { sx: number; sy: number; side: number }`
- Produces: `captureSquareFromVideo(video: HTMLVideoElement, canvas: HTMLCanvasElement, mimeType: string, quality: number): string` (returns data URL; throws `Error` with the two preserved message strings above)

- [ ] **Step 1: Write the failing tests**

Create `src/test/image-processing-square.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import {
  squareCropRect,
  captureSquareFromVideo,
} from '@/components/intake/image-processing'

describe('squareCropRect', () => {
  it('landscape: side = height, x-offset centers', () => {
    expect(squareCropRect(1440, 1080)).toEqual({ sx: 180, sy: 0, side: 1080 })
  })

  it('portrait: side = width, y-offset centers', () => {
    expect(squareCropRect(1080, 1920)).toEqual({ sx: 0, sy: 420, side: 1080 })
  })

  it('square: identity rect', () => {
    expect(squareCropRect(500, 500)).toEqual({ sx: 0, sy: 0, side: 500 })
  })

  it('odd remainder rounds to integer offsets', () => {
    expect(squareCropRect(1281, 720)).toEqual({ sx: 281, sy: 0, side: 720 })
  })
})

function fakeCanvas(ctx: object | null = { drawImage: vi.fn() }) {
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ctx),
    toDataURL: vi.fn(() => 'data:image/jpeg;base64,abc'),
  }
  return canvas
}

describe('captureSquareFromVideo', () => {
  it('draws the center square and forwards format + quality', () => {
    const video = { videoWidth: 1440, videoHeight: 1080 } as HTMLVideoElement
    const ctx = { drawImage: vi.fn() }
    const canvas = fakeCanvas(ctx)
    const out = captureSquareFromVideo(
      video,
      canvas as unknown as HTMLCanvasElement,
      'image/jpeg',
      0.9,
    )
    expect(canvas.width).toBe(1080)
    expect(canvas.height).toBe(1080)
    expect(ctx.drawImage).toHaveBeenCalledWith(
      video, 180, 0, 1080, 1080, 0, 0, 1080, 1080,
    )
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.9)
    expect(out).toBe('data:image/jpeg;base64,abc')
  })

  it('throws the camera-not-ready message on a zero-dimension video', () => {
    const video = { videoWidth: 0, videoHeight: 0 } as HTMLVideoElement
    const canvas = fakeCanvas()
    expect(() =>
      captureSquareFromVideo(
        video,
        canvas as unknown as HTMLCanvasElement,
        'image/jpeg',
        0.9,
      ),
    ).toThrow('Camera not ready yet — try again in a moment.')
  })

  it('throws the canvas-unavailable message when 2D context is missing', () => {
    const video = { videoWidth: 1440, videoHeight: 1080 } as HTMLVideoElement
    const canvas = fakeCanvas(null)
    expect(() =>
      captureSquareFromVideo(
        video,
        canvas as unknown as HTMLCanvasElement,
        'image/jpeg',
        0.9,
      ),
    ).toThrow('Cannot capture — browser canvas unavailable.')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/test/image-processing-square.test.ts`
Expected: FAIL — `squareCropRect` / `captureSquareFromVideo` are not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/components/intake/image-processing.ts` (after `downscaleForCoa`):

```ts
// ---------------------------------------------------------------------------
// Center-square capture (2026-07-14 hotfix)
//
// The ReceiveWizard replaced the old processVialPhoto pipeline with a
// full-frame capture; these helpers restore ONLY the center-square crop at
// full shorter-axis resolution — no downscale, no enhancement.
// ---------------------------------------------------------------------------

/** Centered square source-rect for a width×height frame. */
export function squareCropRect(
  width: number,
  height: number,
): { sx: number; sy: number; side: number } {
  const side = Math.min(width, height)
  return {
    sx: Math.round((width - side) / 2),
    sy: Math.round((height - side) / 2),
    side,
  }
}

/**
 * Capture the center square of a live video frame at full shorter-axis
 * resolution and encode it via the supplied canvas.
 *
 * Throws with the ReceiveWizard's exact operator-facing messages so the
 * caller can surface `err.message` directly.
 */
export function captureSquareFromVideo(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number,
): string {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) {
    throw new Error('Camera not ready yet — try again in a moment.')
  }
  const { sx, sy, side } = squareCropRect(vw, vh)
  canvas.width = side
  canvas.height = side
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Cannot capture — browser canvas unavailable.')
  }
  ctx.drawImage(video, sx, sy, side, side, 0, 0, side, side)
  return canvas.toDataURL(mimeType, quality)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/test/image-processing-square.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/intake/image-processing.ts src/test/image-processing-square.test.ts
git commit -m "feat(intake): center-square crop helpers for vial capture

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: File-picker crop helper

**Files:**
- Modify: `src/components/intake/image-processing.ts` (append after `captureSquareFromVideo`)
- Test: `src/test/image-processing-square.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `squareCropRect` from Task 1.
- Produces: `cropFileToSquare(file: File, mimeType: string, quality: number): Promise<string>` — resolves to a data URL; already-square images resolve to the ORIGINAL file bytes as a data URL (no re-encode); rejects with `Error('Selected file is not an image')` for non-images.

- [ ] **Step 1: Write the failing test**

Append to `src/test/image-processing-square.test.ts` (add `cropFileToSquare` to the existing import from `@/components/intake/image-processing`):

```ts
describe('cropFileToSquare', () => {
  it('rejects non-image files', async () => {
    const file = new File(['not an image'], 'notes.txt', { type: 'text/plain' })
    await expect(
      cropFileToSquare(file, 'image/jpeg', 0.9),
    ).rejects.toThrow('Selected file is not an image')
  })
})
```

(jsdom never fires `Image.onload` for data URLs, so the decode/crop happy path
is not unit-testable here — it is covered by the manual UAT step in Task 3.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/image-processing-square.test.ts`
Expected: FAIL — `cropFileToSquare` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/components/intake/image-processing.ts`:

```ts
/**
 * Center-crop a picked image file to a square at full shorter-axis
 * resolution, re-encoding with the wizard's active format/quality.
 *
 * Already-square images resolve to the ORIGINAL bytes as a data URL — no
 * lossy re-encode. Mirrors the validation/error contract of the legacy
 * processFileImage (webcam-fallback picker).
 */
export function cropFileToSquare(
  file: File,
  mimeType: string,
  quality: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Selected file is not an image'))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.onload = () => {
      const dataUrl = reader.result as string
      const img = new Image()
      img.onerror = () => reject(new Error('Failed to load image'))
      img.onload = () => {
        try {
          if (img.width === 0 || img.height === 0) {
            reject(new Error('Image has no dimensions'))
            return
          }
          if (img.width === img.height) {
            resolve(dataUrl)
            return
          }
          const { sx, sy, side } = squareCropRect(img.width, img.height)
          const canvas = document.createElement('canvas')
          canvas.width = side
          canvas.height = side
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            reject(new Error('Canvas 2D context unavailable'))
            return
          }
          ctx.imageSmoothingEnabled = true
          ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(img, sx, sy, side, side, 0, 0, side, side)
          resolve(canvas.toDataURL(mimeType, quality))
        } catch (err) {
          reject(
            err instanceof Error ? err : new Error('Image processing failed'),
          )
        }
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/test/image-processing-square.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/intake/image-processing.ts src/test/image-processing-square.test.ts
git commit -m "feat(intake): file-picker square-crop helper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire VialPanel to the helpers + square live preview

**Files:**
- Modify: `src/components/intake/ReceiveWizard/VialPanel.tsx` (capture callback ~line 262, `onPickFile` ~line 295, live `<video>` className ~line 525)
- Test: `src/test/vial-panel-capture.test.tsx` (append a describe block)

**Interfaces:**
- Consumes: `captureSquareFromVideo`, `cropFileToSquare` from Tasks 1–2.
- Produces: no new exports; behavior change only.

- [ ] **Step 1: Write the failing component test**

Append to `src/test/vial-panel-capture.test.tsx` (extend the existing vitest import if needed — the file already imports `describe, it, expect, vi, beforeEach, afterEach`):

```ts
describe('VialPanel — center-square capture', () => {
  const videoDescW = Object.getOwnPropertyDescriptor(
    HTMLVideoElement.prototype, 'videoWidth',
  )
  const videoDescH = Object.getOwnPropertyDescriptor(
    HTMLVideoElement.prototype, 'videoHeight',
  )
  const origGetContext = HTMLCanvasElement.prototype.getContext
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL
  let drawImage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
      configurable: true,
      get: () => 1440,
    })
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
      configurable: true,
      get: () => 1080,
    })
    drawImage = vi.fn()
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => ({ drawImage }),
    ) as unknown as typeof HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.toDataURL = vi.fn(
      () => 'data:image/jpeg;base64,sq',
    )
  })

  afterEach(() => {
    if (videoDescW) {
      Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', videoDescW)
    } else {
      Reflect.deleteProperty(HTMLVideoElement.prototype, 'videoWidth')
    }
    if (videoDescH) {
      Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', videoDescH)
    } else {
      Reflect.deleteProperty(HTMLVideoElement.prototype, 'videoHeight')
    }
    HTMLCanvasElement.prototype.getContext = origGetContext
    HTMLCanvasElement.prototype.toDataURL = origToDataURL
  })

  it('captures the center square of the video frame', async () => {
    render(<VialPanel {...baseProps} />)
    const btn = await screen.findByRole('button', { name: /capture photo/i })
    fireEvent.click(btn)
    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(1))
    // drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh): center square of
    // a 1440×1080 frame is 1080×1080 at x-offset 180.
    expect(drawImage.mock.calls[0].slice(1)).toEqual([
      180, 0, 1080, 1080, 0, 0, 1080, 1080,
    ])
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledWith(
      'image/jpeg', 0.9,
    )
    expect(await screen.findByAltText(/captured vial/i)).toHaveAttribute(
      'src', 'data:image/jpeg;base64,sq',
    )
  })

  it('renders the live preview as a square crop (WYSIWYG)', async () => {
    const { container } = render(<VialPanel {...baseProps} />)
    await screen.findByRole('button', { name: /capture photo/i })
    const video = container.querySelector('video')
    expect(video?.className).toContain('aspect-square')
    expect(video?.className).toContain('object-cover')
    expect(video?.className).not.toContain('aspect-[4/3]')
  })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/test/vial-panel-capture.test.tsx`
Expected: the two new tests FAIL (full-frame drawImage args `[0, 0]`-style call and `aspect-[4/3]` class); the original 8 still PASS.

- [ ] **Step 3: Implement the VialPanel changes**

In `src/components/intake/ReceiveWizard/VialPanel.tsx`:

3a. Add the import (next to the existing `capture-options` import near the top of the file):

```ts
import {
  captureSquareFromVideo,
  cropFileToSquare,
} from '@/components/intake/image-processing'
```

3b. Replace the body of the `capture` callback (currently the full-frame draw at ~line 262):

```ts
  const capture = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return
    const v = videoRef.current
    const c = canvasRef.current
    // Center-square crop at full shorter-axis resolution. JPEG (q0.9) is
    // ~10× smaller and feeds the customer order-page gallery directly; PNG
    // stays available (lossless) via the Format toggle. PNG ignores the
    // quality arg.
    try {
      setPhotoDataUrl(
        captureSquareFromVideo(
          v, c, captureMimeType(captureFormat), CAPTURE_JPEG_QUALITY,
        ),
      )
      setLocalError(null)
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : 'Capture failed.',
      )
    }
  }, [captureFormat])
```

3c. Replace the body of `onPickFile` (~line 295) — note the dependency array gains `captureFormat`:

```ts
  const onPickFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0]
      if (!f) return
      cropFileToSquare(f, captureMimeType(captureFormat), CAPTURE_JPEG_QUALITY)
        .then(dataUrl => {
          setPhotoDataUrl(dataUrl)
          setLocalError(null)
        })
        .catch((err: unknown) => {
          setLocalError(
            err instanceof Error
              ? err.message
              : 'Could not load the selected image.',
          )
        })
    },
    [captureFormat],
  )
```

3d. Change the live `<video>` className (~line 525) — this element ONLY, not the captured/existing `<img>` previews (they must keep `object-contain` to show legacy widescreen photos undistorted):

```tsx
                className="block w-full rounded bg-black aspect-square object-cover transition-opacity"
```

- [ ] **Step 4: Run the suite + typecheck**

Run: `npx vitest run src/test/vial-panel-capture.test.tsx src/test/image-processing-square.test.ts`
Expected: PASS (10 + 8 tests).

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/intake/ReceiveWizard/VialPanel.tsx src/test/vial-panel-capture.test.tsx
git commit -m "fix(intake): restore center-square crop for vial photos

Webcam capture and file-picker fallback both center-crop to the shorter
axis at full resolution; live preview is aspect-square object-cover so
operators see exactly what is saved. Packaging capture stays 4:3.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## After the tasks

- Manual UAT (browser): live capture shows a square preview; captured photo is
  square at shorter-axis resolution; picking a widescreen file yields a square;
  picking a square file round-trips; PNG toggle still works; edit-mode retake
  overwrites; a legacy widescreen photo still displays undistorted in edit mode.
- Deploy: Mk1 hotfix v1.5.2 via the accumark-deploy skill (version bump is part
  of the deploy flow, not this plan). PR + master reconcile + ancestor-verify
  after. Prod deploy is Handler-gated.
