import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OrderExpectedVials } from '@/components/intake/OrderExpectedVials'
import type { OrderBoxLabelSummary } from '@/lib/api'

function summary(counts: Record<string, number>): OrderBoxLabelSummary {
  return { order_number: 'WP-1', order_date: null, counts }
}

describe('OrderExpectedVials', () => {
  it('shows a placeholder while loading', () => {
    render(<OrderExpectedVials summary={undefined} loading />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('shows a placeholder when there is no resolvable summary', () => {
    render(<OrderExpectedVials summary={undefined} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('sums the legacy hplc/endo/ster buckets (no hm on this order)', () => {
    render(<OrderExpectedVials summary={summary({ hplc: 2, endo: 1, ster: 2 })} />)
    expect(screen.getByText('5 expected vials')).toBeInTheDocument()
  })

  it('includes the hm bucket in the total — regression guard for the box-label undercount', () => {
    // An HM+legacy order: hplc:1, endo:0, ster:0, hm:1 must total 2, not 1.
    render(<OrderExpectedVials summary={summary({ hplc: 1, endo: 0, ster: 0, hm: 1 })} />)
    expect(screen.getByText('2 expected vials')).toBeInTheDocument()
  })

  it('is shape-driven for any future catalog-only bucket, not just hm', () => {
    render(
      <OrderExpectedVials
        summary={summary({ hplc: 0, endo: 0, ster: 0, hm: 1, future_role: 3 })}
      />
    )
    expect(screen.getByText('4 expected vials')).toBeInTheDocument()
  })

  it('uses singular "vial" for a total of exactly 1', () => {
    render(<OrderExpectedVials summary={summary({ hplc: 0, endo: 0, ster: 0, hm: 1 })} />)
    expect(screen.getByText('1 expected vial')).toBeInTheDocument()
  })
})
