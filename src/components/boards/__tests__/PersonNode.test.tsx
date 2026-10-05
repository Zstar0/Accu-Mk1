import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

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
})
