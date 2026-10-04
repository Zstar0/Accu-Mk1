import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/documents', () => ({
  useDocument: () => ({
    data: {
      id: 10,
      code: 'ART-0001',
      revision: 2,
      title: 'Audit',
      status: 'active',
      category_name: 'Artifact',
      author: 'F',
      co_author: null,
      updated_at: '2026-10-03',
      updated_by: null,
      effective_date: '2026-10-03',
      revisions: [],
      open_comment_count: 2,
    },
    isLoading: false,
    error: null,
  }),
  useDocumentContent: () => ({
    data: '<html><head></head><body><p>hi</p></body></html>',
    isLoading: false,
    error: null,
  }),
  useDocumentCategories: () => ({ data: [] }), // RetitleDialog
  usePatchDocument: () => ({ mutate: vi.fn(), isPending: false }),
  documentKeys: {
    detail: (id: number) => ['documents', 'detail', id],
    lists: ['documents', 'list'],
  },
}))
vi.mock('@/components/flags/EntityFlagButton', () => ({
  EntityFlagButton: () => null,
})) // needs the flags stack; not under test
vi.mock('@/services/document-comments', () => ({
  useDocumentComments: () => ({
    data: { items: [], code: 'ART-0001', latest_revision: 2, open_count: 2 },
  }),
  useCommentLabels: () => ({ data: [] }),
  useCreateComment: () => ({ mutateAsync: vi.fn() }),
  usePatchComment: () => ({ mutateAsync: vi.fn() }),
  useDeleteComment: () => ({ mutate: vi.fn() }),
  useSetCommentStatus: () => ({ mutate: vi.fn() }),
}))
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { id: 1, role: 'admin' } }),
}))

describe('DocumentViewer', () => {
  it('renders the sandboxed frame with the injected bridge and the Comments toggle with its count', async () => {
    const { DocumentViewer } =
      await import('@/components/documents/DocumentViewer')
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DocumentViewer id={10} />
      </QueryClientProvider>
    )
    const frame = screen.getByTitle('Audit') as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('srcdoc')).toContain('/pn-bridge.v')
    expect(frame.getAttribute('srcdoc')).toContain('<!--pn-inject-->')
    expect(
      screen.getByRole('button', { name: /Comments \(2\)/ })
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Select' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Pinpoint' })).toBeInTheDocument()
  })
})
