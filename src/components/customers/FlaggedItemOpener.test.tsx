import { act, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/store/ui-store'
import { navigateToDeepLink } from '@/components/flags/flag-entity'
import { FlaggedItemOpener } from './FlaggedItemOpener'

vi.mock('./SupportThreadPanel', () => ({
  SupportThreadPanel: ({ thread }: { thread: { id: string } | null }) => (
    <div>support panel {thread?.id}</div>
  ),
}))
vi.mock('./CrmActivityPanel', () => ({
  CrmActivityPanel: ({
    item,
  }: {
    item: { id: string; type: string } | null
  }) => (
    <div>
      crm panel {item?.id} {item?.type}
    </div>
  ),
}))

function setup(key = 'wc:1572') {
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      <FlaggedItemOpener customerKey={key} />
    </QueryClientProvider>
  )
}

describe('FlaggedItemOpener', () => {
  beforeEach(() => useUIStore.setState({ pendingCustomerItem: null }))

  it('a customer_item deep link sets the pending item and navigates', () => {
    expect(
      navigateToDeepLink({
        kind: 'customer_item',
        id: 'support:wc:1572|th_01ABC',
      })
    ).toBe(true)
    const s = useUIStore.getState()
    expect(s.customerDetailTargetId).toBe(1572)
    expect(s.pendingCustomerItem).toEqual({
      kind: 'support',
      entityId: 'wc:1572|th_01ABC',
    })
  })

  it('rejects a customer_item link with an unknown kind', () => {
    expect(
      navigateToDeepLink({ kind: 'customer_item', id: 'nope:wc:1|x' })
    ).toBe(false)
  })

  it('opens a pending ticket for this customer', () => {
    useUIStore.setState({
      pendingCustomerItem: { kind: 'support', entityId: 'wc:1572|th_01ABC' },
    })
    setup()
    expect(screen.getByText('support panel th_01ABC')).toBeInTheDocument()
    expect(useUIStore.getState().pendingCustomerItem).toBeNull()
  })

  it('opens a pending CRM item for a viewer without the tab', () => {
    useUIStore.setState({
      pendingCustomerItem: { kind: 'crm', entityId: 'wc:1572|email|acti_1' },
    })
    setup()
    expect(screen.getByText('crm panel acti_1 email')).toBeInTheDocument()
  })

  it('ignores a pending item for another customer', () => {
    useUIStore.setState({
      pendingCustomerItem: { kind: 'support', entityId: 'wc:9|th_01ABC' },
    })
    setup()
    expect(screen.queryByText(/support panel/)).toBeNull()
  })

  it('opens a link that arrives while the customer page is already showing', () => {
    setup()
    expect(screen.queryByText(/support panel/)).toBeNull()
    act(() => {
      navigateToDeepLink({
        kind: 'customer_item',
        id: 'support:wc:1572|th_02XYZ',
      })
    })
    expect(screen.getByText('support panel th_02XYZ')).toBeInTheDocument()
  })
})
