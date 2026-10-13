import { render, screen } from '@testing-library/react'
import { beforeEach, describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({ zoom: 1 }))
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  NodeResizeControl: ({
    onResizeEnd,
  }: {
    onResizeEnd: (e: unknown, p: { width: number; height: number }) => void
  }) => (
    <button onClick={() => onResizeEnd(null, { width: 300, height: 120 })}>
      grip
    </button>
  ),
  useStore: (sel: (s: { transform: number[] }) => unknown) =>
    sel({ transform: [0, 0, h.zoom] }),
}))
const patch = vi.hoisted(() => vi.fn())
vi.mock('@/services/boards', () => ({
  usePatchNode: () => ({ mutate: patch, isPending: false }),
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
  beforeEach(() => patch.mockClear())

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

  it('editors resize a selected note from its corner and the size is saved with the version', () => {
    h.zoom = 1
    render(<NoteNode data={{ row, canEdit: true, slug: 'org' }} selected />)
    screen.getByRole('button', { name: 'grip' }).click()
    expect(patch).toHaveBeenCalledWith({
      id: 9,
      data: { w: 300, h: 120, version: 1 },
    })
  })

  it('viewers get no grip', () => {
    render(<NoteNode data={{ row, canEdit: false, slug: 'org' }} selected />)
    expect(screen.queryByRole('button', { name: 'grip' })).toBeNull()
  })
})
