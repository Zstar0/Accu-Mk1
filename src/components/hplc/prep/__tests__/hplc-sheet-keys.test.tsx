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
const radio = (name: string) => screen.getByRole('radio', { name })

describe('onSheetKey', () => {
  it('Tab and Enter walk past a radio column, never onto it; the arrows stop on it', () => {
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
    // A3: the arrow keys stop on the Lead radio on the way across
    fireEvent.keyDown(sel('b vial'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(radio('b lead'))
    fireEvent.keyDown(radio('b lead'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(box('b target'))
    fireEvent.keyDown(box('b target'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(radio('b lead'))
    fireEvent.keyDown(radio('b lead'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(sel('b vial'))
    for (const r of screen.getAllByRole('radio')) expect(r).not.toBeChecked()
  })

  it('A3: on a Lead radio the sheet takes all four arrow keys', () => {
    renderRadioGrid()
    act(() => radio('a lead').focus())
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft']) {
      const at = document.activeElement as HTMLElement
      expect(fireEvent.keyDown(at, { key })).toBe(false)
    }
    // Up and Down stay in the radio column
    act(() => radio('a lead').focus())
    fireEvent.keyDown(radio('a lead'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(radio('b lead'))
    fireEvent.keyDown(radio('b lead'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(radio('a lead'))
    // Space and Tab are the browser's
    expect(fireEvent.keyDown(radio('a lead'), { key: ' ' })).toBe(true)
    expect(fireEvent.keyDown(radio('a lead'), { key: 'Tab' })).toBe(true)
    for (const r of screen.getAllByRole('radio')) expect(r).not.toBeChecked()
  })

  it('A3: the arrows reach a row button and link past its last box; Tab and Enter never do', () => {
    render(
      <table onKeyDown={onSheetKey}>
        <tbody>
          {['a', 'b'].map(r => (
            <tr key={r}>
              <td>
                <input aria-label={`${r}1`} defaultValue="5012" />
              </td>
              <td>
                <button type="button">{`${r} promote`}</button>
              </td>
              <td>
                <a href="#x">{`${r} link`}</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
    const button = (name: string) => screen.getByRole('button', { name })
    act(() => box('b1').focus())
    // the last box of the walk: Tab is the browser's, Enter stays put
    expect(fireEvent.keyDown(box('b1'), { key: 'Tab' })).toBe(true)
    expect(document.activeElement).toBe(box('b1'))
    fireEvent.keyDown(box('b1'), { key: 'Enter' })
    expect(document.activeElement).toBe(box('b1'))
    act(() => box('a1').focus())
    fireEvent.keyDown(box('a1'), { key: 'Enter' })
    expect(document.activeElement).toBe(box('b1'))
    fireEvent.keyDown(box('b1'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(button('b promote'))
    // Enter and Space on a button are the browser's: it is pressed
    expect(fireEvent.keyDown(button('b promote'), { key: 'Enter' })).toBe(true)
    expect(fireEvent.keyDown(button('b promote'), { key: ' ' })).toBe(true)
    fireEvent.keyDown(button('b promote'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(button('a promote'))
    fireEvent.keyDown(button('a promote'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(
      screen.getByRole('link', { name: 'a link' })
    )
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowLeft',
    })
    fireEvent.keyDown(button('a promote'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(box('a1'))
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
