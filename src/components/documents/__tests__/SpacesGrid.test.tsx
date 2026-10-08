import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SpacesGrid } from '@/components/documents/SpacesGrid'
import type { DocumentSpace } from '@/lib/api-documents'

const space = (over: Partial<DocumentSpace>): DocumentSpace => ({
  id: 1,
  slug: 'general',
  name: 'General',
  description: null,
  visibility: 'company',
  is_active: true,
  sort_order: 0,
  document_count: 3,
  can_write: false,
  created_at: '2026-10-06T00:00:00Z',
  updated_at: '2026-10-06T00:00:00Z',
  ...over,
})

describe('SpacesGrid', () => {
  it('renders one card per space with the count and a lock on restricted ones', () => {
    const onOpen = vi.fn()
    render(
      <SpacesGrid
        spaces={[
          space({}),
          space({
            id: 2,
            slug: 'leadership',
            name: 'Leadership',
            visibility: 'restricted',
            document_count: 1,
          }),
        ]}
        onOpen={onOpen}
      />
    )
    expect(screen.getByRole('button', { name: /General/ })).toHaveTextContent(
      '3 docs'
    )
    const exec = screen.getByRole('button', { name: /Leadership/ })
    expect(exec).toHaveTextContent('Restricted')
    fireEvent.click(exec)
    expect(onOpen).toHaveBeenCalledWith('leadership')
  })

  it('shows the empty hint when there is nothing to show', () => {
    render(<SpacesGrid spaces={[]} onOpen={vi.fn()} />)
    expect(screen.getByText(/No spaces you can see/)).toBeInTheDocument()
  })
})
