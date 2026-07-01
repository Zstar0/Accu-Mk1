import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import {
  createPackagingPhoto,
  updatePackagingPhoto,
  fetchPackagingPhotoUrl,
  type PackagingPhoto,
} from '@/lib/api'

vi.mock('@/lib/api', () => ({
  createPackagingPhoto: vi.fn(),
  updatePackagingPhoto: vi.fn(),
  fetchPackagingPhotoUrl: vi.fn(),
}))

import { PackagingPanel } from '@/components/intake/ReceiveWizard/PackagingPanel'

const mockCreate = vi.mocked(createPackagingPhoto)
const mockUpdate = vi.mocked(updatePackagingPhoto)
const mockFetchUrl = vi.mocked(fetchPackagingPhotoUrl)

// navigator.mediaDevices is absent in jsdom; stub getUserMedia to reject so the
// camera-unavailable branch renders deterministically (the file input is always
// present regardless, which is the path under test).
beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockRejectedValue(new Error('no camera')) },
  })
})

const editingPhoto: PackagingPhoto = {
  id: 42,
  ordering: 0,
  remarks: 'old note',
  content_type: 'image/jpeg',
  created_at: '2026-06-30T00:00:00Z',
  created_by_user_id: 1,
}

function pickFile(container: HTMLElement) {
  const input = container.querySelector(
    'input[type="file"]'
  ) as HTMLInputElement
  const file = new File(['hello-bytes'], 'pkg.jpg', { type: 'image/jpeg' })
  fireEvent.change(input, { target: { files: [file] } })
}

describe('PackagingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchUrl.mockResolvedValue(null)
    mockCreate.mockResolvedValue(editingPhoto)
    mockUpdate.mockResolvedValue(editingPhoto)
  })

  it('does not render a Quantity field', () => {
    const { container } = renderPanelWithContainer()
    expect(screen.queryByText('Quantity')).not.toBeInTheDocument()
    expect(container.querySelector('input[type="number"]')).toBeNull()
  })

  it('file-path + Save calls createPackagingPhoto with a base64 string', async () => {
    const onSaved = vi.fn()
    const { container } = renderPanelWithContainer({ onSaved })

    pickFile(container)
    // Wait for the FileReader onload to land the uploaded preview.
    await screen.findByAltText('Uploaded packaging')

    fireEvent.click(screen.getByRole('button', { name: 'Save packaging photo' }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    const arg = mockCreate.mock.calls[0]![0]
    expect(arg.parentSampleId).toBe('P-1')
    expect(typeof arg.photoBase64).toBe('string')
    expect(arg.photoBase64.length).toBeGreaterThan(0)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it('editing-mode Save calls updatePackagingPhoto(editing.id, …)', async () => {
    renderPanelWithContainer({ editing: editingPhoto })

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockUpdate.mock.calls[0]![0]).toBe(42)
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

// Small helper so tests can grab the render container.
function renderPanelWithContainer(
  props: Partial<React.ComponentProps<typeof PackagingPanel>> = {}
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return render(<PackagingPanel parentSampleId="P-1" {...props} />, { wrapper })
}
