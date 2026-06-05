import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { ResultOptionsEditor } from '@/components/hplc/ResultOptionsEditor'

describe('ResultOptionsEditor', () => {
  it('renders existing rows', () => {
    const { getByDisplayValue } = render(
      <ResultOptionsEditor
        options={[{ value: '1', label: 'Conforms' }]}
        onChange={() => {}}
      />,
    )
    expect(getByDisplayValue('1')).toBeTruthy()
    expect(getByDisplayValue('Conforms')).toBeTruthy()
  })

  it('adds a row on Add option', () => {
    const onChange = vi.fn()
    const { getByText } = render(
      <ResultOptionsEditor options={[]} onChange={onChange} />,
    )
    fireEvent.click(getByText('Add option'))
    expect(onChange).toHaveBeenCalledWith([{ value: '', label: '' }])
  })

  it('removes a row', () => {
    const onChange = vi.fn()
    const { getByLabelText } = render(
      <ResultOptionsEditor
        options={[{ value: '1', label: 'Conforms' }]}
        onChange={onChange}
      />,
    )
    fireEvent.click(getByLabelText('Remove option 1'))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('edits a value', () => {
    const onChange = vi.fn()
    const { getByLabelText } = render(
      <ResultOptionsEditor
        options={[{ value: '1', label: 'Conforms' }]}
        onChange={onChange}
      />,
    )
    fireEvent.change(getByLabelText('Option 1 value'), { target: { value: '2' } })
    expect(onChange).toHaveBeenCalledWith([{ value: '2', label: 'Conforms' }])
  })
})
