import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ flags: [] as unknown[] }))
vi.mock('@/services/boards', () => ({
  useBoardFlags: () => ({ data: h.flags }),
}))
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom' },
}))
vi.mock('@/services/groups', () => ({
  useDirectoryUsers: () => ({
    data: [
      {
        id: 4,
        email: 'ada@lab.test',
        first_name: 'Ada',
        last_name: 'Lovelace',
        title: 'Lab Director',
        avatar_url: null,
      },
    ],
  }),
}))

import { PersonNode } from '@/components/boards/nodes/PersonNode'

const data = (d: Record<string, unknown>) => ({
  row: {
    id: 9,
    board_id: 1,
    kind: 'person' as const,
    label: 'Ada',
    parent_id: null,
    x: 0,
    y: 0,
    w: null,
    h: null,
    z: 0,
    entity_type: null,
    entity_id: null,
    data: d,
    version: 1,
    created_by: null,
    updated_by: null,
    created_at: '',
    updated_at: '',
  },
  canEdit: true,
})

describe('PersonNode', () => {
  beforeEach(() => {
    h.flags = []
  })

  it('shows the name and the title by default (rows without the new keys)', () => {
    render(<PersonNode data={data({ user_id: 4 })} />)
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('Lab Director')).toBeInTheDocument()
    expect(screen.queryByText('ada@lab.test')).not.toBeInTheDocument()
  })

  it('shows the email instead of the name, and hides the title, when asked', () => {
    render(
      <PersonNode
        data={data({ user_id: 4, show: 'email', show_title: false })}
      />
    )
    expect(screen.getByText('ada@lab.test')).toBeInTheDocument()
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument()
    expect(screen.queryByText('Lab Director')).not.toBeInTheDocument()
  })

  it('shows how many of the board flags are assigned to this person', () => {
    h.flags = [
      {
        id: 1,
        assignee_id: 4,
        entity_type: 'board_node',
        entity_id: '9',
        type: 'task',
        status: 'open',
      },
      {
        id: 2,
        assignee_id: 4,
        entity_type: 'board',
        entity_id: '1',
        type: 'task',
        status: 'open',
      },
      {
        id: 3,
        assignee_id: 7,
        entity_type: 'board_node',
        entity_id: '9',
        type: 'task',
        status: 'open',
      },
    ]
    render(<PersonNode data={data({ user_id: 4 })} />)
    expect(screen.getByTestId('person-pill')).toHaveTextContent('2 assigned')
  })
})
