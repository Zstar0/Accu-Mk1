import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CustomerCombobox } from './CustomerCombobox'

const OPTIONS = [
  { name: 'Acme Peptides', samples: 120 },
  { name: 'Beta Labs', samples: 40 },
  { name: 'Bethesda Bio', samples: 7 },
]

function setup(value = '', onChange = vi.fn()) {
  render(
    <CustomerCombobox value={value} options={OPTIONS} onChange={onChange} />
  )
  return {
    input: screen.getByRole('combobox', { name: 'Customer' }),
    onChange,
  }
}

/** Wrapper that behaves like the report: the picked value comes back as a prop. */
function Controlled({ onChange }: { onChange: (v: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <CustomerCombobox
      value={value}
      options={OPTIONS}
      onChange={v => {
        setValue(v)
        onChange(v)
      }}
    />
  )
}

describe('CustomerCombobox', () => {
  it('is closed until the box is focused, then lists every customer', () => {
    const { input } = setup()
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    fireEvent.focus(input)

    expect(input).toHaveAttribute('aria-expanded', 'true')
    const list = screen.getByRole('listbox')
    expect(
      within(list).getByRole('option', { name: /All customers/ })
    ).toBeInTheDocument()
    expect(
      within(list).getByRole('option', { name: /Acme Peptides/ })
    ).toBeInTheDocument()
    expect(
      within(list).getByRole('option', { name: /Beta Labs/ })
    ).toBeInTheDocument()
  })

  it('narrows the list to the typed fragment, case-insensitively', () => {
    const { input } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'bet' } })

    const list = screen.getByRole('listbox')
    expect(
      within(list).getByRole('option', { name: /Beta Labs/ })
    ).toBeInTheDocument()
    expect(
      within(list).getByRole('option', { name: /Bethesda Bio/ })
    ).toBeInTheDocument()
    expect(
      within(list).queryByRole('option', { name: /Acme Peptides/ })
    ).not.toBeInTheDocument()
  })

  it('does not report a change until an option is picked', () => {
    const { input, onChange } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'beta' } })
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('option', { name: /Beta Labs/ }))
    expect(onChange).toHaveBeenCalledWith('Beta Labs')
  })

  it('shows the picked customer in the box and closes the list', () => {
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    const input = screen.getByRole('combobox', { name: 'Customer' })

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'beta l' } })
    fireEvent.click(screen.getByRole('option', { name: /Beta Labs/ }))

    expect(input).toHaveValue('Beta Labs')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('reports the empty string for "All customers"', () => {
    const { input, onChange } = setup('Beta Labs')
    expect(input).toHaveValue('Beta Labs')

    fireEvent.focus(input)
    fireEvent.click(screen.getByRole('option', { name: /All customers/ }))
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('restores the committed customer when Escape closes the list', () => {
    const { input, onChange } = setup('Beta Labs')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'acme' } })
    expect(input).toHaveValue('acme')

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(input).toHaveValue('Beta Labs')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('restores the committed customer when focus leaves without a pick', () => {
    const { input, onChange } = setup('Beta Labs')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'acme' } })
    fireEvent.blur(input, { relatedTarget: document.body })

    expect(input).toHaveValue('Beta Labs')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('picks the highlighted option with the arrow keys and Enter', () => {
    const { input, onChange } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'bet' } })
    // Filtered list: Beta Labs, Bethesda Bio.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('Bethesda Bio')
  })

  it('marks the highlighted option for assistive tech', () => {
    const { input } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'beta' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })

    const option = screen.getByRole('option', { name: /Beta Labs/ })
    expect(option).toHaveAttribute('aria-selected', 'true')
    expect(input).toHaveAttribute('aria-activedescendant', option.id)
  })

  it('holds focus in the box while an option is being clicked', () => {
    // A real browser blurs the input on mousedown, which would close the list
    // before the click landed on the option. jsdom does not, so assert the
    // guard itself: the option cancels the mousedown default.
    const { input } = setup()
    fireEvent.focus(input)
    const option = screen.getByRole('option', { name: /Beta Labs/ })

    const notCancelled = fireEvent.mouseDown(option)

    expect(notCancelled).toBe(false)
  })

  it('says so when nothing matches', () => {
    const { input } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'zzz' } })

    expect(screen.getByText('No matching customer')).toBeInTheDocument()
    expect(
      screen.queryByRole('option', { name: /Acme Peptides/ })
    ).not.toBeInTheDocument()
  })

  it('keeps showing a committed customer that is not in the option list', () => {
    const { input } = setup('Gamma Chemical')
    expect(input).toHaveValue('Gamma Chemical')
  })
})
