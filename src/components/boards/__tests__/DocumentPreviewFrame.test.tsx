import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/services/documents', () => ({
  useDocumentContent: vi.fn(),
}))
vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light' }),
}))
vi.mock('@/components/documents/DocumentViewer', () => ({
  usePrefersDark: () => false,
}))

import { DocumentPreviewFrame } from '@/components/boards/DocumentPreviewFrame'
import { useDocumentContent } from '@/services/documents'

describe('DocumentPreviewFrame', () => {
  it('renders a sandboxed srcdoc iframe with no src (M5)', () => {
    vi.mocked(useDocumentContent).mockReturnValue({
      data: '<html><body><p>Hello</p></body></html>',
      isLoading: false,
    } as never)
    render(<DocumentPreviewFrame id={1} />)
    const frame = screen.getByTitle('Document preview')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.hasAttribute('srcdoc')).toBe(true)
    expect(frame.getAttribute('srcdoc')).toContain('Hello')
    expect(frame.hasAttribute('src')).toBe(false)
  })

  it('says the document is restricted or missing when content cannot load', () => {
    vi.mocked(useDocumentContent).mockReturnValue({
      isLoading: false,
      data: undefined,
      error: new Error('GET failed: 404'),
    } as never)
    render(<DocumentPreviewFrame id={5} />)
    expect(
      screen.getByText(/restricted or no longer exists/)
    ).toBeInTheDocument()
  })
})
