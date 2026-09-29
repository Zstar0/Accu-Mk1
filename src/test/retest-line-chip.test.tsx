import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RetestLineChip } from '@/components/senaite/AnalysisTable'

describe('RetestLineChip', () => {
  it('renders both kinds with explanatory titles', () => {
    render(
      <>
        <RetestLineChip kind="retesting" />
        <RetestLineChip kind="added" />
      </>
    )
    expect(screen.getByText('Retesting')).toHaveAttribute(
      'title',
      expect.stringMatching(/re-run on this retest/i)
    )
    expect(screen.getByText('Added')).toHaveAttribute(
      'title',
      expect.stringMatching(/added on this retest/i)
    )
  })
})
