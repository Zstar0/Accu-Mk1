import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { useUIStore } from '@/store/ui-store'
import { BackToOrigin } from './BackToOrigin'

describe('BackToOrigin', () => {
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
