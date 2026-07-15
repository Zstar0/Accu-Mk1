import { describe, it, expect, vi } from 'vitest'
import {
  squareCropRect,
  captureSquareFromVideo,
  cropFileToSquare,
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

describe('cropFileToSquare', () => {
  it('rejects non-image files', async () => {
    const file = new File(['not an image'], 'notes.txt', { type: 'text/plain' })
    await expect(
      cropFileToSquare(file, 'image/jpeg', 0.9),
    ).rejects.toThrow('Selected file is not an image')
  })
})
