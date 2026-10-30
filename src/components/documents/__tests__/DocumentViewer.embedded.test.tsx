import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DocumentViewer } from '@/components/documents/DocumentViewer'
import { useUIStore } from '@/store/ui-store'

// The real module is a 5,200-line template literal; keep it out of this file.
vi.mock('@/vendor/plannotator/bridge-script', () => ({
  BRIDGE_PROTOCOL_VERSION: 1,
  ANNOTATION_HIGHLIGHT_CSS: '',
}))

const h = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  isPending: false,
  toastError: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: h.toastError, success: vi.fn() } }))

vi.mock('@/services/documents', () => ({
  useDocumentSpaces: () => ({ data: [], isLoading: false }),
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
      revisions: [
        { id: 10, revision: 2, code: 'ART-0001', status: 'superseded' },
        { id: 11, revision: 3, code: 'ART-0001', status: 'active' },
      ],
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
  useReplaceDraftContent: () => ({ mutateAsync: vi.fn() }),
  useCreateRevision: () => ({ mutateAsync: vi.fn() }),
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
    data: { items: [], code: 'ART-0001', latest_revision: 2, open_count: 3 },
  }),
  useCommentLabels: () => ({
    data: [
      {
        id: 'nice-work',
        emoji: 'x',
        text: 'Nice work',
        color: 'green',
        tip: null,
      },
    ],
  }),
  useCreateComment: () => ({
    mutateAsync: h.mutateAsync,
    isPending: h.isPending,
  }),
  usePatchComment: () => ({ mutateAsync: vi.fn() }),
  useDeleteComment: () => ({ mutate: vi.fn() }),
  useSetCommentStatus: () => ({ mutate: vi.fn() }),
}))
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { id: 1, role: 'admin' } }),
}))

describe('DocumentViewer embedded', { timeout: 20_000 }, () => {
  it('hides the back button and keeps revision navigation local', async () => {
    const globalNav = vi.fn()
    useUIStore.setState({ navigateToDocument: globalNav })
    const onNavigate = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DocumentViewer id={10} embedded onNavigate={onNavigate} />
      </QueryClientProvider>
    )
    expect(screen.queryByRole('button', { name: /^Documents$/ })).toBeNull()
    await userEvent.click(
      screen.getByRole('button', { name: /Newest revision/ })
    )
    expect(onNavigate).toHaveBeenCalledWith(11)
    expect(globalNav).not.toHaveBeenCalled()
  })

  it('still shows the back button when not embedded', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DocumentViewer id={10} />
      </QueryClientProvider>
    )
    expect(
      screen.getByRole('button', { name: /Documents/ })
    ).toBeInTheDocument()
  })
})
