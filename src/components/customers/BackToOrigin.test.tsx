import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { useUIStore } from '@/store/ui-store'
import { BackToOrigin } from './BackToOrigin'

const initial = useUIStore.getState()

describe('BackToOrigin', () => {
  beforeEach(() => {
    // Each case starts from the store's initial navigation, not the last case's.
    useUIStore.setState({
      activeSection: initial.activeSection,
      activeSubSection: initial.activeSubSection,
      customerDetailOrigin: initial.customerDetailOrigin,
    })
  })

  it('labels Back to Insights and navigates back to Insights', async () => {
    useUIStore.setState({
      customerDetailOrigin: 'customer-insights',
      activeSubSection: 'customer-detail',
    })
    render(<BackToOrigin />)
    await userEvent.click(
      screen.getByRole('button', { name: /Back to Insights/ })
    )
    expect(useUIStore.getState().activeSubSection).toBe('customer-insights')
  })

  it('labels Back to Customers when the origin is customers', () => {
    useUIStore.setState({ customerDetailOrigin: 'customers' })
    render(<BackToOrigin />)
    expect(
      screen.getByRole('button', { name: /Back to Customers/ })
    ).toBeInTheDocument()
  })
})
