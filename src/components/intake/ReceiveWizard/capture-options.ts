// Pure helpers for the Receive-wizard photo-capture controls: image-format
// selection and camera-resolution options derived from the device's real
// capabilities. Framework-free on purpose — the logic is unit-tested without
// a DOM or camera mock.

export type CaptureFormat = 'jpeg' | 'png'

/** JPEG quality for canvas.toDataURL. Ignored by PNG (lossless). */
export const CAPTURE_JPEG_QUALITY = 0.9

/** Map a capture format to its canvas/MIME type. */
export function captureMimeType(format: CaptureFormat): string {
  return format === 'png' ? 'image/png' : 'image/jpeg'
}

export interface ResOption {
  value: string
  label: string
  w?: number
  h?: number
}

// Capture-resolution presets. The dropdown is filtered to what the camera
// actually supports (see supportedResOptions); 'default' = unconstrained.
export const RES_OPTIONS: ResOption[] = [
  { value: 'default', label: 'Default (camera native)' },
  { value: '640x480', label: '640 × 480', w: 640, h: 480 },
  { value: '1280x720', label: '1280 × 720 (HD)', w: 1280, h: 720 },
  { value: '1920x1080', label: '1920 × 1080 (FHD)', w: 1920, h: 1080 },
  { value: '2560x1440', label: '2560 × 1440 (QHD)', w: 2560, h: 1440 },
  { value: '3840x2160', label: '3840 × 2160 (4K)', w: 3840, h: 2160 },
]

/** Subset of MediaStreamTrack.getCapabilities() we care about. */
export interface CaptureCapabilities {
  width?: { max?: number }
  height?: { max?: number }
}

/**
 * Filter the presets to those the camera can deliver. 'default' (no w/h) is
 * always kept. With unknown capabilities, returns all presets — we can't
 * filter, so we don't hide anything.
 */
export function supportedResOptions(
  caps: CaptureCapabilities | null,
): ResOption[] {
  const maxW = caps?.width?.max
  const maxH = caps?.height?.max
  if (maxW == null || maxH == null) return RES_OPTIONS
  return RES_OPTIONS.filter(
    o => o.w == null || (o.w <= maxW && (o.h ?? 0) <= maxH),
  )
}

/**
 * Value of the highest-resolution preset the camera supports, or null when
 * capabilities are unknown. Used to pick a sharp default instead of letting an
 * unconstrained stream sit at the camera's low default (often 640×480).
 */
export function highestSupportedResValue(
  caps: CaptureCapabilities | null,
): string | null {
  // Unknown OR incomplete capabilities (null, {}, or only one dimension) →
  // null, so a caller never gets a resolution the camera hasn't confirmed.
  if (caps?.width?.max == null || caps?.height?.max == null) return null
  const sized = supportedResOptions(caps).filter(o => o.w != null)
  if (sized.length === 0) return null
  return sized.reduce((best, o) =>
    o.w! * o.h! > best.w! * best.h! ? o : best,
  ).value
}

/** Build getUserMedia video constraints for a chosen preset value. */
export function videoConstraints(res: string): MediaTrackConstraints {
  const c: MediaTrackConstraints = { facingMode: 'environment' }
  const opt = RES_OPTIONS.find(o => o.value === res)
  if (opt?.w && opt?.h) {
    c.width = { ideal: opt.w }
    c.height = { ideal: opt.h }
  }
  return c
}
