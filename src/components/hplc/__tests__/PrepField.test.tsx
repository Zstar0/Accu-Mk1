import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { PrepField } from '@/components/hplc/EndoPrepLine'

// These cells drive what a technician pipettes. An entry the cell refuses
// must stay visible and marked, never quietly snap back to the old number.

function renderField(onCommit = vi.fn()) {
  render(
    <PrepField
      bare
      label="Declared weight"
      unit="mg"
      value={20}
      overridden={false}
      computed={20}
      disabled={false}
      onCommit={onCommit}
    />
  )
  const input = screen.getByLabelText(
    'Declared weight (mg)'
  ) as HTMLInputElement
  return { input, onCommit }
}

describe('PrepField', () => {
  it.each(['1,5', '0', '-3', 'abc'])(
    'keeps a refused entry (%s) in the cell and marks it',
    text => {
      const { input, onCommit } = renderField()
      fireEvent.change(input, { target: { value: text } })
      fireEvent.blur(input)
      expect(onCommit).not.toHaveBeenCalled()
      expect(input.value).toBe(text)
      expect(input).toHaveAttribute('aria-invalid', 'true')
    }
  )

  it('clears the mark as soon as the entry is edited, and commits a good one', () => {
    const { input, onCommit } = renderField()
    fireEvent.change(input, { target: { value: '1,5' } })
    fireEvent.blur(input)
    fireEvent.change(input, { target: { value: '1.5' } })
    expect(input).not.toHaveAttribute('aria-invalid', 'true')
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith(1.5)
  })

  it('Escape throws a refused entry away and shows the real number again', () => {
    const { input, onCommit } = renderField()
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('20')
    expect(input).not.toHaveAttribute('aria-invalid', 'true')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('commits nothing when a cell is tabbed through untouched', () => {
    const { input, onCommit } = renderField()
    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
  })
})
