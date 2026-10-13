import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@xyflow/react', () => ({ NodeResizeControl: () => null }))
const h = vi.hoisted(() => ({
  flags: [] as unknown[],
  nodes: [] as unknown[],
}))
vi.mock('@/services/boards', () => ({
  usePatchNode: () => ({ mutate: vi.fn(), isPending: false }),
  useBoardFlags: () => ({ data: h.flags }),
  useBoard: () => ({ data: { nodes: h.nodes } }),
}))
vi.mock('@/services/flag-types', () => ({
  useFlagTypes: () => ({
    data: [
      { slug: 'blocker', is_blocking: true },
      { slug: 'task', is_blocking: false },
    ],
  }),
}))

import { FrameNode } from '@/components/boards/nodes/FrameNode'

const row = {
  id: 1,
  board_id: 1,
  kind: 'frame' as const,
  label: 'Marketing',
  parent_id: null,
  x: 0,
  y: 0,
  w: 400,
  h: 200,
  z: 0,
  entity_type: null,
  entity_id: null,
  data: { color: 'purple' },
  version: 1,
  created_by: null,
  updated_by: null,
  created_at: '',
  updated_at: '',
}
const flag = (o: object) => ({
  id: 1,
  entity_type: 'board_node',
  entity_id: '2',
  kind: 'issue',
  type: 'task',
  status: 'open',
  title: 'T',
  created_by: 1,
  assignee_id: null,
  created_at: '',
  updated_at: '',
  resolved_at: null,
  resolved_by: null,
  due_at: null,
  ...o,
})

describe('FrameNode rollup pills', () => {
  it('shows blocking and open counts for the frame and its children, nothing when empty', () => {
    h.nodes = [
      row,
      { ...row, id: 2, kind: 'note', parent_id: 1 },
      { ...row, id: 3, kind: 'note', parent_id: null },
    ]
    h.flags = [
      flag({ id: 1, entity_id: '2', type: 'blocker' }),
      flag({ id: 2, entity_id: '1' }),
      flag({ id: 3, entity_id: '3' }),
    ]
    render(
      <FrameNode data={{ row, canEdit: false, slug: 'org' }} selected={false} />
    )
    expect(screen.getByTestId('frame-pill-blocking')).toHaveTextContent(
      '1 blocking'
    )
    expect(screen.getByTestId('frame-pill-open')).toHaveTextContent('1 open')
  })

  it('renders no pills without flags', () => {
    h.nodes = [row]
    h.flags = []
    render(
      <FrameNode data={{ row, canEdit: false, slug: 'org' }} selected={false} />
    )
    expect(screen.queryByTestId('frame-pill-blocking')).toBeNull()
    expect(screen.queryByTestId('frame-pill-open')).toBeNull()
  })
})
