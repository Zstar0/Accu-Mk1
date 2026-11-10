import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Outcome } from '@/components/hplc/endo/EndoPromoteDialog'

// A Variance replicate is entered on the worksheet and signed off later with
// Verify (Variance): the server answers promoted false, state to_be_verified.
// That is a success, so it must not read as a refusal.

const REPLICATE =
  'replicate vial: result entered, sign it off with Verify (Variance) on the sample page'

describe('Outcome', () => {
  it('shows a replicate as entered', () => {
    render(
      <Outcome
        result={{
          item_id: 1,
          promoted: false,
          state: 'to_be_verified',
          reason: REPLICATE,
        }}
      />
    )
    const text = screen.getByText(REPLICATE)
    expect(text.className).toContain('text-emerald-700')
    expect(screen.queryByText(/Not promoted/)).toBeNull()
  })

  it('still shows a refusal as not promoted', () => {
    render(
      <Outcome
        result={{
          item_id: 2,
          promoted: false,
          state: null,
          reason: 'no reading',
        }}
      />
    )
    const text = screen.getByText('Not promoted: no reading')
    expect(text.className).toContain('text-red-600')
  })
})
