import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { VialPanel } from '@/components/intake/ReceiveWizard/VialPanel'

vi.mock('@/lib/api', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, fetchSubSamplePhotoUrl: vi.fn().mockResolvedValue(null) }
})
vi.mock('@/components/samples/usePrintLabel', () => ({
  usePrintLabel: () => ({ printLabel: vi.fn(), target: null }),
}))

const baseProps = {
  parentSampleId: 'P-0993',
  parentDetails: null,
  editingSub: null,
  loading: false,
  error: null,
  onSaveNew: vi.fn().mockResolvedValue({ sampleId: 'P-0993-S01' }),
  onSaveNewBulk: vi.fn().mockResolvedValue({ created: 3 }),
  onSaveEdit: vi.fn().mockResolvedValue(undefined),
  onDelete: vi.fn().mockResolvedValue(undefined),
}

function vid(deviceId: string, label = ''): MediaDeviceInfo {
  return { kind: 'videoinput', deviceId, label, groupId: '' } as MediaDeviceInfo
}

// Minimal getUserMedia mock so the live-capture controls render. The track
// reports capabilities used by the resolution test (Task 3). `devices` feeds
// enumerateDevices; ids in `rejectDeviceIds` make a pinned getUserMedia fail
// like an unplugged camera (OverconstrainedError).
function mockCamera(
  maxW = 1920,
  maxH = 1080,
  opts: { devices?: MediaDeviceInfo[]; rejectDeviceIds?: string[] } = {},
) {
  const devices = opts.devices ?? [vid('cam-1', 'Webcam')]
  const getUserMedia = vi.fn((constraints: MediaStreamConstraints) => {
    const video = constraints.video as MediaTrackConstraints | undefined
    const exact = (video?.deviceId as { exact?: string } | undefined)?.exact
    if (exact && opts.rejectDeviceIds?.includes(exact)) {
      return Promise.reject(
        new DOMException('device not found', 'OverconstrainedError'),
      )
    }
    const track = {
      stop: vi.fn(),
      getCapabilities: () => ({ width: { max: maxW }, height: { max: maxH } }),
      getSettings: () => ({ deviceId: exact ?? devices[0]?.deviceId }),
    }
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
    return Promise.resolve(stream)
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(() => Promise.resolve(devices)),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  })
  return { getUserMedia }
}

beforeEach(() => {
  localStorage.clear()
  mockCamera()
})
afterEach(() => {
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices
})

describe('VialPanel — capture format toggle', () => {
  it('shows a Format selector defaulting to JPEG', async () => {
    render(<VialPanel {...baseProps} />)
    const sel = (await screen.findByLabelText(/capture image format/i)) as HTMLSelectElement
    expect(sel.value).toBe('jpeg')
  })

  it('persists the chosen format to localStorage', async () => {
    render(<VialPanel {...baseProps} />)
    const sel = (await screen.findByLabelText(/capture image format/i)) as HTMLSelectElement
    fireEvent.change(sel, { target: { value: 'png' } })
    expect(localStorage.getItem('wizard-capture-format')).toBe('png')
  })
})

describe('VialPanel — resolution mode-selection', () => {
  it('filters the resolution list to camera-supported modes', async () => {
    mockCamera(1280, 720)
    render(<VialPanel {...baseProps} />)
    const sel = (await screen.findByLabelText(
      /capture resolution/i,
    )) as HTMLSelectElement
    await waitFor(() => {
      const values = Array.from(sel.options).map(o => o.value)
      expect(values).toContain('1280x720')
      expect(values).not.toContain('3840x2160')
    })
  })

  it('auto-corrects a saved resolution the camera cannot reach', async () => {
    localStorage.setItem('wizard-capture-res', '3840x2160')
    mockCamera(1280, 720)
    render(<VialPanel {...baseProps} />)
    const sel = (await screen.findByLabelText(
      /capture resolution/i,
    )) as HTMLSelectElement
    await waitFor(() => expect(sel.value).toBe('1280x720'))
  })
})

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
    expect(drawImage.mock.calls.at(0)?.slice(1)).toEqual([
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

describe('VialPanel — camera device selector', () => {
  it('shows a Camera selector when more than one camera is present', async () => {
    mockCamera(1920, 1080, {
      devices: [vid('cam-1', 'Webcam'), vid('cam-2', 'Doc cam')],
    })
    render(<VialPanel {...baseProps} />)
    const sel = (await screen.findByLabelText(
      /capture camera/i,
    )) as HTMLSelectElement
    await waitFor(() => {
      const labels = Array.from(sel.options).map(o => o.textContent)
      expect(labels).toEqual(expect.arrayContaining(['Webcam', 'Doc cam']))
    })
  })

  it('hides the Camera selector with a single camera', async () => {
    mockCamera(1920, 1080, { devices: [vid('cam-1', 'Webcam')] })
    render(<VialPanel {...baseProps} />)
    await screen.findByLabelText(/capture resolution/i)
    expect(screen.queryByLabelText(/capture camera/i)).not.toBeInTheDocument()
  })

  it('restarts the stream pinned to the chosen device and persists it', async () => {
    const ctl = mockCamera(1920, 1080, {
      devices: [vid('cam-1', 'Webcam'), vid('cam-2', 'Doc cam')],
    })
    render(<VialPanel {...baseProps} />)
    const sel = (await screen.findByLabelText(
      /capture camera/i,
    )) as HTMLSelectElement
    fireEvent.change(sel, { target: { value: 'cam-2' } })
    await waitFor(() => {
      const last = ctl.getUserMedia.mock.calls.at(-1)?.[0] as
        | MediaStreamConstraints
        | undefined
      expect((last?.video as MediaTrackConstraints).deviceId).toEqual({
        exact: 'cam-2',
      })
    })
    expect(localStorage.getItem('wizard-camera-device')).toBe('cam-2')
  })

  it('falls back to the default camera when the saved device is gone', async () => {
    localStorage.setItem('wizard-camera-device', 'cam-gone')
    const ctl = mockCamera(1920, 1080, {
      devices: [vid('cam-1', 'Webcam')],
      rejectDeviceIds: ['cam-gone'],
    })
    render(<VialPanel {...baseProps} />)
    // The fallback stream must bring the live controls up, not the
    // camera-unavailable branch.
    await screen.findByRole('button', { name: /capture photo/i })
    await waitFor(() => {
      const calls = ctl.getUserMedia.mock.calls
      const first = calls.at(0)?.[0] as MediaStreamConstraints | undefined
      const last = calls.at(-1)?.[0] as MediaStreamConstraints | undefined
      expect((first?.video as MediaTrackConstraints).deviceId).toEqual({
        exact: 'cam-gone',
      })
      expect((last?.video as MediaTrackConstraints).deviceId).toBeUndefined()
    })
    expect(localStorage.getItem('wizard-camera-device')).toBeNull()
  })
})
