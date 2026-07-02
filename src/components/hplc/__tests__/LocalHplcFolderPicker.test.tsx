import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LocalHplcFolderPicker } from '../LocalHplcFolderPicker'

function fileWith(name: string, content: string): File {
  const file = new File([content], name, { type: 'text/csv' })
  Object.defineProperty(file, 'webkitRelativePath', { value: `Batch7/${name}` })
  // jsdom File.text() exists; ensure deterministic
  Object.defineProperty(file, 'text', { value: async () => content })
  return file
}

describe('LocalHplcFolderPicker', () => {
  it('calls onSelected with folder name + classified local files', async () => {
    const onSelected = vi.fn()
    render(<LocalHplcFolderPicker onSelected={onSelected} />)
    const input = screen.getByTestId('local-folder-input') as HTMLInputElement
    const files = [fileWith('P1_PeakData.csv', 'peak'), fileWith('P1.dx_DAD1A.CSV', 'chrom')]
    Object.defineProperty(input, 'files', { value: files })
    fireEvent.change(input)
    await waitFor(() => expect(onSelected).toHaveBeenCalledTimes(1))
    expect(onSelected).toHaveBeenCalledWith('Batch7', [
      { filename: 'P1_PeakData.csv', content: 'peak', kind: 'peak' },
      { filename: 'P1.dx_DAD1A.CSV', content: 'chrom', kind: 'chrom' },
    ])
  })

  it('does not call onSelected when the folder has no PeakData', async () => {
    const onSelected = vi.fn()
    render(<LocalHplcFolderPicker onSelected={onSelected} />)
    const input = screen.getByTestId('local-folder-input') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [fileWith('notes.txt', 'x')] })
    fireEvent.change(input)
    await waitFor(() => expect(screen.getByText(/No .*PeakData/i)).toBeInTheDocument())
    expect(onSelected).not.toHaveBeenCalled()
  })
})
