import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  create: vi.fn(),
  search: [{ entity_id: 'SOP-0001', label: 'SOP-0001 · Sample check-in' }],
}))
vi.mock('@/services/boards', () => ({
  useCreateNode: () => ({ mutate: h.create, isPending: false }),
}))
vi.mock('@/services/groups', () => ({
  useDirectoryUsers: () => ({
    data: [{ id: 10, email: 'd@x.t', first_name: 'Dennis', last_name: 'L' }],
    isLoading: false,
  }),
}))
vi.mock('@/hooks/use-flags', () => ({
  useEntitySearch: () => ({ data: h.search, isLoading: false }),
}))

import { AddNodePalette } from '@/components/boards/AddNodePalette'
import type { BoardDetail } from '@/lib/api-boards'

const board = {
  id: 1,
  slug: 'org',
  name: 'Org',
  kind: 'map',
  visibility: 'company',
  created_by: 1,
  default_viewport: null,
  node_count: 0,
  can_edit: true,
  created_at: '',
  updated_at: '',
  nodes: [],
  edges: [],
  grants: [],
} as BoardDetail

describe('AddNodePalette', () => {
  beforeEach(() => h.create.mockReset())

  it('creates a frame at the drop point', async () => {
    render(
      <AddNodePalette
        board={board}
        open
        onOpenChange={() => undefined}
        dropAt={{ x: 100, y: 50 }}
        parentId={null}
      />
    )
    await userEvent.setup().click(screen.getByText('Frame'))
    expect(h.create).toHaveBeenCalledWith(
      {
        kind: 'frame',
        label: 'New frame',
        x: 100,
        y: 50,
        w: 360,
        h: 220,
        parent_id: null,
        data: { color: 'slate' },
      },
      expect.anything()
    )
  })

  it('creates a document entity node from the typeahead', async () => {
    const user = userEvent.setup()
    render(
      <AddNodePalette
        board={board}
        open
        onOpenChange={() => undefined}
        dropAt={{ x: 0, y: 0 }}
        parentId={7}
      />
    )
    await user.click(screen.getByText('Document'))
    await user.click(await screen.findByText('SOP-0001 · Sample check-in'))
    expect(h.create).toHaveBeenCalledWith(
      {
        kind: 'entity',
        label: '',
        entity_type: 'document',
        entity_id: 'SOP-0001',
        x: 0,
        y: 0,
        parent_id: 7,
        data: {},
      },
      expect.anything()
    )
  })

  it('creates a person node from the directory', async () => {
    const user = userEvent.setup()
    render(
      <AddNodePalette
        board={board}
        open
        onOpenChange={() => undefined}
        dropAt={{ x: 0, y: 0 }}
        parentId={null}
      />
    )
    await user.click(screen.getByText('Person'))
    await user.click(await screen.findByText(/Dennis L/))
    expect(h.create).toHaveBeenCalledWith(
      {
        kind: 'person',
        label: 'Dennis L',
        x: 0,
        y: 0,
        parent_id: null,
        data: { user_id: 10 },
      },
      expect.anything()
    )
  })

  it('opens straight on the document search when given an initial entity step', () => {
    render(
      <AddNodePalette
        board={board}
        open
        onOpenChange={() => undefined}
        dropAt={{ x: 0, y: 0 }}
        parentId={null}
        initial={{ step: 'entity', entityType: 'document' }}
      />
    )
    expect(screen.getByPlaceholderText('Search document...')).toBeVisible()
    expect(screen.queryByText('Frame')).toBeNull()
  })

  it('keeps a server hit visible when its label does not fuzzy-match the typed query', async () => {
    h.search = [{ entity_id: 'SOP-0001', label: 'SOP-0001' }]
    const user = userEvent.setup()
    render(
      <AddNodePalette
        board={board}
        open
        onOpenChange={() => undefined}
        dropAt={{ x: 0, y: 0 }}
        parentId={7}
      />
    )
    await user.click(screen.getByText('Document'))
    await user.type(screen.getByPlaceholderText('Search document...'), 'check')
    await user.click(await screen.findByText('SOP-0001'))
    expect(h.create).toHaveBeenCalledWith(
      {
        kind: 'entity',
        label: '',
        entity_type: 'document',
        entity_id: 'SOP-0001',
        x: 0,
        y: 0,
        parent_id: 7,
        data: {},
      },
      expect.anything()
    )
  })
})
