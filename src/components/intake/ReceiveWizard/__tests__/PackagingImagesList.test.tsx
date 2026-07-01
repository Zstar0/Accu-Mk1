import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import {
  listPackagingPhotos,
  deletePackagingPhoto,
  fetchPackagingPhotoUrl,
  type PackagingPhoto,
} from '@/lib/api'

vi.mock('@/lib/api', () => ({
  listPackagingPhotos: vi.fn(),
  deletePackagingPhoto: vi.fn(),
  fetchPackagingPhotoUrl: vi.fn(),
}))

import { PackagingImagesList } from '@/components/intake/ReceiveWizard/PackagingImagesList'

const mockList = vi.mocked(listPackagingPhotos)
const mockDelete = vi.mocked(deletePackagingPhoto)
const mockFetchUrl = vi.mocked(fetchPackagingPhotoUrl)

const photo = (id: number, remarks: string | null = null): PackagingPhoto => ({
  id,
  ordering: id,
  remarks,
  content_type: 'image/jpeg',
  created_at: '2026-06-30T00:00:00Z',
  created_by_user_id: 1,
})

function renderList(onEdit?: (p: PackagingPhoto) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  render(
    <PackagingImagesList parentSampleId="P-1" onEdit={onEdit} />,
    { wrapper },
  )
  return { qc }
}

describe('PackagingImagesList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchUrl.mockResolvedValue(null)
    mockDelete.mockResolvedValue(undefined)
  })

  it('renders one item per photo returned by listPackagingPhotos', async () => {
    mockList.mockResolvedValue([photo(1, 'front'), photo(2, 'back'), photo(3)])
    renderList()

    await waitFor(() => expect(screen.getByText('front')).toBeInTheDocument())
    expect(screen.getByText('back')).toBeInTheDocument()
    expect(screen.getAllByLabelText('Delete packaging image')).toHaveLength(3)
  })

  it('header reads "Packaging Images"', async () => {
    mockList.mockResolvedValue([])
    renderList()

    expect(screen.getByText('Packaging Images')).toBeInTheDocument()
  })

  it('clicking delete calls deletePackagingPhoto', async () => {
    mockList.mockResolvedValue([photo(7, 'seal')])
    renderList()

    const delBtn = await screen.findByLabelText('Delete packaging image')
    fireEvent.click(delBtn)

    await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1))
    expect(mockDelete).toHaveBeenCalledWith(7)
  })

  it('clicking an item calls onEdit with the photo', async () => {
    mockList.mockResolvedValue([photo(9, 'lid')])
    const onEdit = vi.fn()
    renderList(onEdit)

    const item = await screen.findByText('lid')
    fireEvent.click(item)

    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }))
  })
})
