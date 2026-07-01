import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import {
  listPackagingPhotos,
  fetchPackagingPhotoUrl,
  type PackagingPhoto,
} from '@/lib/api'

// SampleDetails pulls many named exports from '@/lib/api'; the group under test
// only touches these two. Everything else is unused at import time.
vi.mock('@/lib/api', () => ({
  listPackagingPhotos: vi.fn(),
  fetchPackagingPhotoUrl: vi.fn(),
}))

import { PackagingAttachmentsGroup } from '@/components/senaite/SampleDetails'

const mockList = vi.mocked(listPackagingPhotos)
const mockFetchUrl = vi.mocked(fetchPackagingPhotoUrl)

const photo = (id: number, remarks: string | null = null): PackagingPhoto => ({
  id,
  ordering: id,
  remarks,
  content_type: 'image/jpeg',
  created_at: '2026-06-30T00:00:00Z',
  created_by_user_id: 1,
})

function renderGroup(parentSampleId = 'P-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  render(<PackagingAttachmentsGroup parentSampleId={parentSampleId} />, { wrapper })
  return { qc }
}

describe('PackagingAttachmentsGroup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchUrl.mockResolvedValue('blob:fake-url')
  })

  it('renders a "Packaging" group with a thumbnail per row and no edit/delete controls', async () => {
    mockList.mockResolvedValue([photo(1, 'front'), photo(2, 'back'), photo(3)])
    renderGroup()

    // Group heading
    await waitFor(() => expect(screen.getByText('Packaging')).toBeInTheDocument())

    // One thumbnail (img) per photo once the blob URLs resolve
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(3))

    // Remarks surfaced
    expect(screen.getByText('front')).toBeInTheDocument()
    expect(screen.getByText('back')).toBeInTheDocument()

    // Read-only: no controls at all
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByLabelText(/delete/i)).toBeNull()
    expect(screen.queryByLabelText(/edit/i)).toBeNull()
  })

  it('renders nothing when there are no packaging photos', async () => {
    mockList.mockResolvedValue([])
    const { qc } = renderGroup()

    // Let the query settle, then assert the heading never appears
    await waitFor(() =>
      expect(qc.getQueryState(['packaging-photos', 'P-1'])?.status).toBe('success'),
    )
    expect(screen.queryByText('Packaging')).toBeNull()
  })
})
