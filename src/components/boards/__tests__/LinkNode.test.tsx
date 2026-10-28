import { render, screen } from '@testing-library/react'
import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
}))
const h = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('@/components/boards/open-external', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, openExternal: h.open }
})

import { LinkNode } from '@/components/boards/nodes/LinkNode'

const data = (url: string) => ({
  row: {
    id: 9,
    board_id: 1,
    kind: 'link' as const,
    label: 'Kinsta',
    parent_id: null,
    x: 0,
    y: 0,
    w: null,
    h: null,
    z: 0,
    entity_type: null,
    entity_id: null,
    data: { url },
    version: 1,
    created_by: null,
    updated_by: null,
    created_at: '',
    updated_at: '',
  },
  canEdit: true,
})

describe('LinkNode', () => {
  beforeEach(() => h.open.mockReset())

  it('renders an http(s) link and opens it externally', () => {
    render(<LinkNode data={data('https://accumarklabs.com')} />)
    screen.getByRole('button', { name: /accumarklabs\.com/ }).click()
    expect(h.open).toHaveBeenCalledWith('https://accumarklabs.com')
    expect(document.querySelector('a[href]')).toBeNull()
  })

  it('never renders a javascript: url as a target (Review Focus 4)', () => {
    render(<LinkNode data={data('javascript:alert(1)')} />)
    const btn = screen.getByRole('button')
    expect(btn).toBeDisabled()
    btn.click()
    expect(h.open).not.toHaveBeenCalled()
    expect(document.querySelector('a[href]')).toBeNull()
  })
})
