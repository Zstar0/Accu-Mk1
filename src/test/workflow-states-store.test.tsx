import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useWorkflowStatesStore, labelFor } from '@/lib/workflow-states-store'
import { StateBadge } from '@/components/senaite/senaite-utils'

beforeEach(() => {
  useWorkflowStatesStore.setState({ states: {} })
})

describe('workflow states store', () => {
  it('falls back to the hardcoded map when the store is empty', () => {
    render(<StateBadge state="to_be_verified" />)
    expect(screen.getByText('To Verify')).toBeInTheDocument()
    expect(labelFor('on_hold', 'on_hold')).toBe('on_hold')
  })

  it('uses the catalog label once loaded, including runtime-added states', () => {
    useWorkflowStatesStore.getState().setStates([
      { id: 1, slug: 'to_be_verified', label: 'Awaiting review', category: 'active', sort_order: 60 } as never,
      { id: 2, slug: 'on_hold', label: 'On hold', category: 'active', sort_order: 55 } as never,
    ])
    render(<><StateBadge state="to_be_verified" /><StateBadge state="on_hold" /></>)
    expect(screen.getByText('Awaiting review')).toBeInTheDocument()
    expect(screen.getByText('On hold')).toBeInTheDocument()
  })
})
