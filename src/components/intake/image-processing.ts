/**
 * Pure Canvas API image processing pipeline for vial product photos.
 *
 * Two-stage sizing:
 *   1. PREVIEW size (500 x 496) — stored in state / sessionStorage for on-screen use
 *   2. COA size (125 x 124) — produced at export time for the final document
 */

/** Final COA dimensions */
export const COA_WIDTH = 125
export const COA_HEIGHT = 124

/** Preview dimensions (4x COA for crisp on-screen display) */
const PREVIEW_WIDTH = 500
const PREVIEW_HEIGHT = 496

const CONTRAST_STRENGTH = 2.5

// ---------------------------------------------------------------------------
// Histogram helpers
// ---------------------------------------------------------------------------

function percentileBounds(
  hist: Uint32Array,
  total: number,
  lo: number,
  hi: number
): [number, number] {
  const loThresh = total * lo
  const hiThresh = total * hi
  let cumulative = 0
  let low = 0
  let high = 255
  for (let i = 0; i < 256; i++) {
    cumulative += hist[i] ?? 0
    if (cumulative < loThresh) low = i
    if (cumulative < hiThresh) high = i
  }
  return [low, high]
}

function channelMean(hist: Uint32Array, total: number): number {
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * (hist[i] ?? 0)
  return sum / total
}

// ---------------------------------------------------------------------------
// Combined LUT builder: stretch → S-curve → white-balance in one pass
// ---------------------------------------------------------------------------

function buildCombinedLut(lo: number, hi: number, wbScale: number): Uint8Array {
  const lut = new Uint8Array(256)
  const range = hi - lo || 1
  for (let i = 0; i < 256; i++) {
    const stretched = Math.max(0, Math.min(1, (i - lo) / range))
    const curved = 0.5 + 0.5 * Math.tanh(CONTRAST_STRENGTH * (stretched - 0.5))
    const balanced = curved * wbScale
    lut[i] = Math.max(0, Math.min(255, Math.round(balanced * 255)))
  }
  return lut
}

// ---------------------------------------------------------------------------
// Step-down high-quality downscale
// ---------------------------------------------------------------------------

function stepDownScale(
  source: HTMLCanvasElement,
  targetW: number,
  targetH: number
): HTMLCanvasElement {
  let currentW = source.width
  let currentH = source.height
  let src: HTMLCanvasElement | OffscreenCanvas = source

  // Halve repeatedly until the next halve would go below target
  while (currentW / 2 > targetW && currentH / 2 > targetH) {
    const halfW = Math.round(currentW / 2)
    const halfH = Math.round(currentH / 2)
    const step = document.createElement('canvas')
    step.width = halfW
    step.height = halfH
    const ctx = step.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context unavailable')
    ctx.drawImage(src as HTMLCanvasElement, 0, 0, halfW, halfH)
    src = step
    currentW = halfW
    currentH = halfH
  }

  // Final draw to exact target size
  const output = document.createElement('canvas')
  output.width = targetW
  output.height = targetH
  const outCtx = output.getContext('2d')
  if (!outCtx) throw new Error('Canvas 2D context unavailable')
  outCtx.imageSmoothingEnabled = true
  outCtx.imageSmoothingQuality = 'high'
  outCtx.drawImage(src as HTMLCanvasElement, 0, 0, targetW, targetH)
  return output
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Capture, crop, optionally enhance, and downscale a video frame to a
 * 500 x 496 preview data URL (4x the final COA size).
 *
 * @param video      The live <video> element (must have an active stream)
 * @param canvas     An offscreen <canvas> element to use as a work surface
 * @param guideRatio Fraction of the shorter video axis covered by the guide
 * @param enhance    When true, applies auto-levels / contrast / white-balance
 * @param zoomCrop   When true, crops to the guide square; when false, captures the full frame as a square
 * @returns PNG data URL of the processed 500 x 496 image
 */
export function processVialPhoto(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  guideRatio: number,
  enhance = true,
  zoomCrop = false
): string {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (vw === 0 || vh === 0) throw new Error('Video has no dimensions')

  // --- Step 1: Crop to square ---
  const shorter = Math.min(vw, vh)
  const cropSize = zoomCrop
    ? Math.round(shorter * guideRatio) // Zoom: crop to guide square
    : shorter // No zoom: use full shorter axis (center-square)
  const sx = Math.round((vw - cropSize) / 2)
  const sy = Math.round((vh - cropSize) / 2)

  canvas.width = cropSize
  canvas.height = cropSize
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  ctx.drawImage(video, sx, sy, cropSize, cropSize, 0, 0, cropSize, cropSize)

  // --- Step 2–5: Post-processing (optional) ---
  if (enhance) {
    const imageData = ctx.getImageData(0, 0, cropSize, cropSize)
    const data = imageData.data
    const pixelCount = data.length / 4

    const histR = new Uint32Array(256)
    const histG = new Uint32Array(256)
    const histB = new Uint32Array(256)

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] as number
      const g = data[i + 1] as number
      const b = data[i + 2] as number
      histR[r] = (histR[r] ?? 0) + 1
      histG[g] = (histG[g] ?? 0) + 1
      histB[b] = (histB[b] ?? 0) + 1
    }

    // Auto-levels (1st / 99th percentile stretch)
    const [rLo, rHi] = percentileBounds(histR, pixelCount, 0.01, 0.99)
    const [gLo, gHi] = percentileBounds(histG, pixelCount, 0.01, 0.99)
    const [bLo, bHi] = percentileBounds(histB, pixelCount, 0.01, 0.99)

    // White-balance (gray-world)
    const avgR = channelMean(histR, pixelCount)
    const avgG = channelMean(histG, pixelCount)
    const avgB = channelMean(histB, pixelCount)
    const avgAll = (avgR + avgG + avgB) / 3

    const scaleR = avgAll / (avgR || 1)
    const scaleG = avgAll / (avgG || 1)
    const scaleB = avgAll / (avgB || 1)

    // Build combined LUTs and apply
    const lutR = buildCombinedLut(rLo, rHi, scaleR)
    const lutG = buildCombinedLut(gLo, gHi, scaleG)
    const lutB = buildCombinedLut(bLo, bHi, scaleB)

    for (let i = 0; i < data.length; i += 4) {
      data[i] = lutR[data[i] as number] as number
      data[i + 1] = lutG[data[i + 1] as number] as number
      data[i + 2] = lutB[data[i + 2] as number] as number
    }
    ctx.putImageData(imageData, 0, 0)
  }

  // --- Step 6: High-quality downscale to preview size (500 x 496) ---
  const preview = stepDownScale(canvas, PREVIEW_WIDTH, PREVIEW_HEIGHT)

  // --- Step 7: Export as data URL ---
  return preview.toDataURL('image/png')
}

/**
 * Downscale a preview data URL to the final COA dimensions (125 x 124).
 * Call this at export time, not at capture time.
 */
export function downscaleForCoa(previewDataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = COA_WIDTH
      canvas.height = COA_HEIGHT
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Canvas 2D context unavailable'))
        return
      }
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, COA_WIDTH, COA_HEIGHT)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('Failed to load preview image'))
    img.src = previewDataUrl
  })
}
