import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { TypeBucketBoard } from '@/components/flags/TypeBucketBoard'
import type { FlagType } from '@/lib/flags-api'

function type(over: Partial<FlagType>): FlagType {
  return {
    id: 1,
    slug: 'blocker',
    label: 'Blocker',
    color: '#e5484d',
    kind: 'issue',
    is_blocking: true,
    is_active: true,
    sort_order: 0,
    entity_types: [],
    is_builtin: true,
    ...over,
  }
}

const buckets = [
  { slug: 'sample', label: 'Sample' },
  { slug: 'general_task', label: 'General Task' },
]

describe('TypeBucketBoard', () => {
  it('places types in the buckets their scope names (incl. multi-bucket)', () => {
    const types = [
      type({ id: 1, label: 'Global', entity_types: [] }),
      type({ id: 2, label: 'SampleOnly', entity_types: ['sample'] }),
      type({ id: 3, label: 'Both', entity_types: ['sample', 'general_task'] }),
    ]
    render(
      <TypeBucketBoard
        types={types}
        buckets={buckets}
        readOnly={false}
        onScope={vi.fn()}
      />
    )

    const allItems = screen.getByRole('group', { name: 'All items' })
    expect(within(allItems).getByText('Global')).toBeInTheDocument()
    expect(within(allItems).queryByText('SampleOnly')).not.toBeInTheDocument()

    const sample = screen.getByRole('group', { name: 'Sample' })
    expect(within(sample).getByText('SampleOnly')).toBeInTheDocument()
    expect(within(sample).getByText('Both')).toBeInTheDocument()

    const general = screen.getByRole('group', { name: 'General Task' })
    expect(within(general).getByText('Both')).toBeInTheDocument()
    expect(within(general).queryByText('SampleOnly')).not.toBeInTheDocument()
  })

  it('✕ on a bucket chip removes just that slug via onScope', () => {
    const onScope = vi.fn()
    const types = [
      type({ id: 3, label: 'Both', entity_types: ['sample', 'general_task'] }),
    ]
    render(
      <TypeBucketBoard
        types={types}
        buckets={buckets}
        readOnly={false}
        onScope={onScope}
      />
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Both from Sample' })
    )
    expect(onScope).toHaveBeenCalledWith(3, ['general_task'])
  })

  it('hides the ✕ affordance when read-only', () => {
    const types = [type({ id: 2, label: 'SampleOnly', entity_types: ['sample'] })]
    render(
      <TypeBucketBoard
        types={types}
        buckets={buckets}
        readOnly
        onScope={vi.fn()}
      />
    )
    expect(
      screen.queryByRole('button', { name: /Remove SampleOnly/ })
    ).not.toBeInTheDocument()
  })
})
