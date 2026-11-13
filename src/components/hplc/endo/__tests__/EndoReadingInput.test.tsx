import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { EndoReadingInput } from '@/components/hplc/endo/EndoReadingInput'

// The reading drives the verdict and the value that goes to Accu-Mk1. A text
// the cell refuses must stay visible and marked, never snap back silently.

function renderInput(value: string | null = null, disabled = false) {
  const onCommit = vi.fn()
  render(
    <EndoReadingInput
      value={value}
      placeholder="<0.05"
      disabled={disabled}
      label="Reading for P-0001-S02"
      onCommit={onCommit}
    />
  )
  return { onCommit }
}

const input = () =>
  screen.getByLabelText('Reading for P-0001-S02') as HTMLInputElement

describe('EndoReadingInput', () => {
  it.each([
    ['<0.05', '<0.05'],
    ['< 0.05', '<0.05'],
    ['0.8', '0.8'],
    ['0', '0'],
  ])('saves %s as %s', (typed, saved) => {
    const { onCommit } = renderInput()
    fireEvent.change(input(), { target: { value: typed } })
    fireEvent.blur(input())
    expect(onCommit).toHaveBeenCalledWith(saved)
    expect(input()).not.toHaveAttribute('aria-invalid')
  })

  it.each(['abc', '0,8', '-1', '<0', '<'])(
    'keeps %s in the cell, marked, and saves nothing',
    typed => {
      const { onCommit } = renderInput()
      fireEvent.change(input(), { target: { value: typed } })
      fireEvent.blur(input())
      expect(onCommit).not.toHaveBeenCalled()
      expect(input().value).toBe(typed)
      expect(input()).toHaveAttribute('aria-invalid', 'true')
    }
  )

  it('clears a saved reading when emptied, and Escape restores a refused one', () => {
    const { onCommit } = renderInput('0.8')
    fireEvent.change(input(), { target: { value: 'x' } })
    fireEvent.blur(input())
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(input().value).toBe('0.8')
    fireEvent.change(input(), { target: { value: '' } })
    fireEvent.blur(input())
    expect(onCommit).toHaveBeenCalledWith(null)
  })

  it('is plain text when disabled', () => {
    renderInput('<0.05', true)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('<0.05')).toBeInTheDocument()
  })
})
