import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/services/documents', () => ({
  useDocumentContent: () => ({
    data: '<html><body><p>Hello</p></body></html>',
    isLoading: false,
  }),
}))
vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light' }),
}))
vi.mock('@/components/documents/DocumentViewer', () => ({
  usePrefersDark: () => false,
}))

import { DocumentPreviewFrame } from '@/components/boards/DocumentPreviewFrame'

describe('DocumentPreviewFrame', () => {
  it('renders a sandboxed srcdoc iframe with no src (M5)', () => {
    render(<DocumentPreviewFrame id={1} />)
    const frame = screen.getByTitle('Document preview')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.hasAttribute('srcdoc')).toBe(true)
    expect(frame.getAttribute('srcdoc')).toContain('Hello')
    expect(frame.hasAttribute('src')).toBe(false)
  })
})
