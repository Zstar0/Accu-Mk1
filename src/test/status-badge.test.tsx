import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBadge } from '@/components/senaite/AnalysisTable'

// On a sub-sample (vial) row, `to_be_verified` means "result captured, awaiting
// promotion" — verification can't happen at the vial tier. So a promotable row
// reads "Ready to Promote". A parent SENAITE line in the same raw state genuinely
// awaits verification and must keep "To Verify"; the per-row `promotable` flag
// (isPromotable: mk1 vial row, to_be_verified, unpromoted) is what distinguishes them.
describe('StatusBadge', () => {
  it('labels a promotable to_be_verified row "Ready to Promote"', () => {
    render(<StatusBadge state="to_be_verified" promotable />)
    expect(screen.getByText('Ready to Promote')).toBeInTheDocument()
    expect(screen.queryByText('To Verify')).not.toBeInTheDocument()
  })

  it('keeps "To Verify" for a non-promotable to_be_verified row (parent SENAITE line)', () => {
    render(<StatusBadge state="to_be_verified" />)
    expect(screen.getByText('To Verify')).toBeInTheDocument()
    expect(screen.queryByText('Ready to Promote')).not.toBeInTheDocument()
  })

  it('leaves other states unchanged even when promotable is set', () => {
    render(<StatusBadge state="verified" promotable />)
    expect(screen.getByText('Verified')).toBeInTheDocument()
  })
})
