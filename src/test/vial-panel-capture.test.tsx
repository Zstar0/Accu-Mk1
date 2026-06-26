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

// Minimal getUserMedia mock so the live-capture controls render. The track
// reports capabilities used by the resolution test (Task 3).
function mockCamera(maxW = 1920, maxH = 1080) {
  const track = {
    stop: vi.fn(),
    getCapabilities: () => ({ width: { max: maxW }, height: { max: maxH } }),
  }
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  })
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
