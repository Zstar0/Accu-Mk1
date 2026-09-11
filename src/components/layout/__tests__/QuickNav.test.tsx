import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const uiState = {
  navigateToSample: vi.fn(),
  navigateToCustomers: vi.fn(),
  setSearchAndResetPage: vi.fn(),
  navigateToOrderStatus: vi.fn(),
  navigateTo: vi.fn(),
}
vi.mock('@/store/ui-store', () => {
  const useUIStore = <T,>(selector: (s: typeof uiState) => T): T => selector(uiState)
  ;(useUIStore as unknown as { getState: () => typeof uiState }).getState = () => uiState
  return { useUIStore }
})

const counts = { ready: 0, partial: 0 }
vi.mock('@/hooks/use-ready-to-publish-count', () => ({
  useReadyToPublishCount: () => counts,
}))

import { QuickNav, ReadyToPublishChips } from '@/components/layout/QuickNav'

function type(label: string, value: string) {
  const box = screen.getByRole('textbox', { name: label })
  fireEvent.change(box, { target: { value } })
  fireEvent.keyDown(box, { key: 'Enter' })
  return box as HTMLInputElement
}

describe('QuickNav', () => {
  beforeEach(() => {
    Object.values(uiState).forEach(fn => fn.mockClear())
    counts.ready = 0
    counts.partial = 0
  })

  it('Sample ID goes to the sample details page, uppercased, and clears the box', () => {
    render(<QuickNav />)
    const box = type('Sample ID', ' p-2605 ')
    expect(uiState.navigateToSample).toHaveBeenCalledWith('P-2605')
    expect(box.value).toBe('')
  })

  it('Customer Email opens the customer list already filtered', () => {
    render(<QuickNav />)
    type('Customer Email', 'lab@acme.test')
    expect(uiState.navigateToCustomers).toHaveBeenCalled()
    expect(uiState.setSearchAndResetPage).toHaveBeenCalledWith('lab@acme.test')
    // order matters: the list-search term is set AFTER the navigator resets slots
    const navOrder = uiState.navigateToCustomers.mock.invocationCallOrder[0]!
    const setOrder = uiState.setSearchAndResetPage.mock.invocationCallOrder[0]!
    expect(navOrder).toBeLessThan(setOrder)
  })

  it('Order ID hands the id to Order Status', () => {
    render(<QuickNav />)
    type('Order ID', '5812')
    expect(uiState.navigateToOrderStatus).toHaveBeenCalledWith('5812')
  })

  it('an empty Enter does nothing', () => {
    render(<QuickNav />)
    type('Sample ID', '   ')
    expect(uiState.navigateToSample).not.toHaveBeenCalled()
  })

  it('Ready to Publish button navigates to the report and shows both chips', () => {
    counts.ready = 7
    counts.partial = 2
    render(<QuickNav />)
    fireEvent.click(screen.getByRole('button', { name: /Ready to Publish/ }))
    expect(uiState.navigateTo).toHaveBeenCalledWith('reports', 'ready-to-publish')
    expect(screen.getByTitle('7 ready to publish (all lines verified)')).toHaveTextContent('7')
    expect(screen.getByTitle('2 ready for partial publish')).toHaveTextContent('2')
  })

  it('chips hide at zero and cap at 99+', () => {
    counts.ready = 250
    const { container } = render(<ReadyToPublishChips />)
    expect(container.textContent).toBe('99+')
    expect(screen.queryByTitle(/partial/)).toBeNull()
  })
})
