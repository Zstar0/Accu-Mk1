import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { RunTick } from '@/components/hplc/PcrWorksheetView'

// The run-level Plate made / Ran on QuantStudio boxes tick every row at once.
// Like the endo sheet's tick-all headings they only ever SET (Handler,
// 2026-09-23): one slip must not wipe a whole run's who/when stamps.

function renderTick(checked: boolean, onSet = vi.fn(), disabled = false) {
  render(
    <RunTick
      label="Plate made"
      count={checked ? '7/7' : '3/7'}
      checked={checked}
      disabled={disabled}
      onSet={onSet}
    />
  )
  return { box: screen.getByRole('checkbox', { name: 'Plate made' }), onSet }
}

describe('RunTick', () => {
  it('ticks every row when some are still open', () => {
    const { box, onSet } = renderTick(false)
    fireEvent.click(box)
    expect(onSet).toHaveBeenCalledTimes(1)
  })

  it('never clears: once every row is ticked the box stays ticked and does nothing', () => {
    const { box, onSet } = renderTick(true)
    expect(box).toBeDisabled()
    expect(box).toHaveAttribute('data-state', 'checked')
    fireEvent.click(box)
    expect(onSet).not.toHaveBeenCalled()
  })

  it('does nothing on a completed worksheet', () => {
    const { box, onSet } = renderTick(false, vi.fn(), true)
    fireEvent.click(box)
    expect(onSet).not.toHaveBeenCalled()
  })
})
