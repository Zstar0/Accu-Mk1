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

/** Vial select, Lead radio, Own Target box: Step 2b's shape. */
function renderRadioGrid() {
  render(
    <table onKeyDown={onSheetKey}>
      <tbody>
        {['a', 'b'].map(r => (
          <tr key={r}>
            <td>
              <select aria-label={`${r} vial`} defaultValue="A">
                <option>A</option>
                <option>B</option>
              </select>
            </td>
            <td>
              <input type="radio" name="lead" aria-label={`${r} lead`} />
            </td>
            <td>
              <input aria-label={`${r} target`} defaultValue="200" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
const sel = (name: string) => screen.getByRole('combobox', { name })

describe('onSheetKey', () => {
  it('Tab, Enter and the arrows walk past a radio column, never onto it', () => {
    renderRadioGrid()
    act(() => sel('a vial').focus())
    fireEvent.keyDown(sel('a vial'), { key: 'Tab' })
    expect(document.activeElement).toBe(sel('b vial'))
    // the last select: Tab goes to the top of the next typed column
    fireEvent.keyDown(sel('b vial'), { key: 'Tab' })
    expect(document.activeElement).toBe(box('a target'))
    fireEvent.keyDown(box('a target'), { key: 'Enter' })
    expect(document.activeElement).toBe(box('b target'))
    fireEvent.keyDown(box('b target'), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(box('a target'))
    fireEvent.keyDown(box('a target'), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(sel('b vial'))
    // ArrowRight from a select skips the radio
    fireEvent.keyDown(sel('b vial'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(box('b target'))
    fireEvent.keyDown(box('b target'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(sel('b vial'))
    for (const r of screen.getAllByRole('radio')) expect(r).not.toBeChecked()
  })

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
