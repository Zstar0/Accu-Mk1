import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({ zoom: 1 }))
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  NodeResizeControl: () => null,
  useStore: (sel: (s: { transform: number[] }) => unknown) =>
    sel({ transform: [0, 0, h.zoom] }),
}))
vi.mock('@/services/boards', () => ({
  usePatchNode: () => ({ mutate: vi.fn(), isPending: false }),
}))

import { NoteNode } from '@/components/boards/nodes/NoteNode'

const row = {
  id: 9,
  board_id: 1,
  kind: 'note' as const,
  label: 'Q4',
  parent_id: null,
  x: 0,
  y: 0,
  w: null,
  h: null,
  z: 0,
  entity_type: null,
  entity_id: null,
  data: { markdown: 'body text here' },
  version: 1,
  created_by: null,
  updated_by: null,
  created_at: '',
  updated_at: '',
}

describe('NoteNode', () => {
  it('renders the body at normal zoom', () => {
    h.zoom = 1
    render(<NoteNode data={{ row, canEdit: false }} selected={false} />)
    expect(screen.getByText('body text here')).toBeInTheDocument()
  })

  it('hides the body below 0.5 zoom and keeps the title', () => {
    h.zoom = 0.3
    render(<NoteNode data={{ row, canEdit: false }} selected={false} />)
    expect(screen.getByText('Q4')).toBeInTheDocument()
    expect(screen.queryByText('body text here')).toBeNull()
  })
})
