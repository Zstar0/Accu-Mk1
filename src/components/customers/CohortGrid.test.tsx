import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CohortGrid } from './CohortGrid'

describe('CohortGrid', () => {
  it('selects a cohort, then a cell, and clears on a second click', async () => {
    const onSelect = vi.fn()
    render(
      <CohortGrid
        months={['M1', 'M2']}
        rows={[{ cohort: '2026-08', size: 163, cells: [0.129, null] }]}
        selectedCohort={null}
        selectedMonth={null}
        onSelect={onSelect}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: '2026-08' }))
    expect(onSelect).toHaveBeenCalledWith('2026-08', null)
    await userEvent.click(screen.getByRole('button', { name: '12.9%' }))
    expect(onSelect).toHaveBeenCalledWith('2026-08', 'M1')
    expect(screen.queryByRole('button', { name: '' })).toBeNull() // the null cell is not a button
  })

  it('a selected cell is pressed and clicking it clears', async () => {
    const onSelect = vi.fn()
    render(
      <CohortGrid
        months={['M1']}
        rows={[{ cohort: '2026-08', size: 163, cells: [0.129] }]}
        selectedCohort="2026-08"
        selectedMonth="M1"
        onSelect={onSelect}
      />
    )
    const cell = screen.getByRole('button', { name: '12.9%' })
    expect(cell).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(cell)
    expect(onSelect).toHaveBeenCalledWith(null, null)
  })
})
