import { describe, it, expect } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { onSheetKey } from '../hplc-sheet-keys'

function renderGrid() {
  render(
    <table onKeyDown={onSheetKey}>
      <tbody>
        {['a', 'b'].map(r => (
          <tr key={r}>
            <td>
              <input aria-label={`${r}1`} defaultValue="5012" />
            </td>
            <td>
              <input aria-label={`${r}2`} defaultValue="80" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
const box = (name: string) =>
  screen.getByRole('textbox', { name }) as HTMLInputElement

describe('onSheetKey', () => {
  it('a click into a box arrived at by keyboard puts Left and Right back on the caret', () => {
    renderGrid()
    act(() => box('b1').focus())
    fireEvent.keyDown(box('b1'), { key: 'ArrowUp' })
    const a1 = box('a1')
    expect(document.activeElement).toBe(a1)
    expect(a1.dataset.navFresh).toBe('1')
    // the tech clicks mid-number
    fireEvent.mouseDown(a1)
    a1.setSelectionRange(2, 2)
    const moved = !fireEvent.keyDown(a1, { key: 'ArrowRight' })
    expect(moved).toBe(false)
    expect(document.activeElement).toBe(a1)
  })
})
