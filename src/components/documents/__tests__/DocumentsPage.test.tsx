import { render, screen, fireEvent, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentSpace } from '@/lib/api-documents'

const general: DocumentSpace = {
  id: 1,
  slug: 'general',
  name: 'General',
  description: null,
  visibility: 'company',
  is_active: true,
  sort_order: 0,
  document_count: 0,
  can_write: false,
  created_at: '2026-10-06T00:00:00Z',
  updated_at: '2026-10-06T00:00:00Z',
}

const leadership: DocumentSpace = {
  ...general,
  id: 2,
  slug: 'leadership',
  name: 'Leadership',
}

const useDocuments = vi.fn()
vi.mock('@/services/documents', () => ({
  useDocumentSpaces: () => ({ data: [general, leadership], isLoading: false }),
  useDocumentCategories: () => ({ data: [] }),
  useDocuments: (p: unknown) => useDocuments(p),
}))
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQuery: () => ({ data: [] }),
}))
vi.mock('@/components/documents/DocumentViewer', () => ({
  DocumentViewer: () => null,
}))

import { DocumentsPage } from '@/components/documents/DocumentsPage'
import { useUIStore } from '@/store/ui-store'

describe('DocumentsPage', () => {
  beforeEach(() => {
    useDocuments.mockReset()
    useDocuments.mockReturnValue({
      data: { items: [], total: 0 },
      isLoading: false,
      isFetching: false,
      error: null,
    })
  })

  it('shows the grid with no space selected and the scoped list when one is', async () => {
    useUIStore.setState({
      documentsSpaceSlug: null,
      documentViewerTargetId: null,
    })
    render(<DocumentsPage />)
    expect(
      await screen.findByRole('button', { name: /General/ })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /General/ }))
    expect(useUIStore.getState().documentsSpaceSlug).toBe('general')
    expect(
      await screen.findByRole('heading', { name: 'Documents / General' })
    ).toBeInTheDocument()
    expect(useDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({ spaceId: 1 })
    )
  })

  it('shows the empty state for an unknown space slug', async () => {
    useUIStore.setState({
      documentsSpaceSlug: 'nope',
      documentViewerTargetId: null,
    })
    render(<DocumentsPage />)
    expect(await screen.findByText(/No documents match/)).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Documents / nope' })
    ).toBeInTheDocument()
    expect(useDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({ spaceId: -1 })
    )
  })

  it('remounts the list on a direct space switch, resetting filters', async () => {
    useUIStore.setState({
      documentsSpaceSlug: 'general',
      documentViewerTargetId: null,
    })
    render(<DocumentsPage />)
    const input = await screen.findByPlaceholderText(/Search code/)
    fireEvent.change(input, { target: { value: 'abc' } })
    expect(input).toHaveValue('abc')
    act(() => useUIStore.setState({ documentsSpaceSlug: 'leadership' }))
    expect(
      await screen.findByRole('heading', { name: 'Documents / Leadership' })
    ).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Search code/)).toHaveValue('')
    expect(useDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({ spaceId: 2 })
    )
  })
})
