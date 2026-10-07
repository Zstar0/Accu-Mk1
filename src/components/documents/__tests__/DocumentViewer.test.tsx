import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentViewer } from '@/components/documents/DocumentViewer'
import { BRIDGE_PROTOCOL_VERSION } from '@/vendor/plannotator/bridge-script'

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

describe('DocumentViewer', { timeout: 20_000 }, () => {
  it('renders the sandboxed frame with the injected bridge and the Comments toggle with its count', async () => {
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
      screen.getByRole('button', { name: /Comments \(3\)/ })
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Select' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Pinpoint' })).toBeInTheDocument()
  })

  async function mount() {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DocumentViewer id={10} />
      </QueryClientProvider>
    )
    return screen.getByTitle('Audit') as HTMLIFrameElement
  }
  const post = (frame: HTMLIFrameElement, data: unknown) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data,
          origin: 'null',
          source: frame.contentWindow ?? undefined,
        })
      )
    })
  const select = (frame: HTMLIFrameElement) => {
    post(frame, {
      type: 'plannotator-bridge-ready',
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    })
    post(frame, {
      type: 'plannotator-bridge-selection',
      text: 'hi',
      rect: { top: 1, left: 1, width: 5, height: 5 },
    })
  }

  beforeEach(() => {
    h.mutateAsync.mockReset()
    h.toastError.mockReset()
    h.isPending = false
  })

  it('fills its pane until the bridge is ready, then follows the reported height', async () => {
    const frame = await mount()
    expect(frame.style.height).toBe('100%')
    post(frame, {
      type: 'plannotator-bridge-ready',
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    })
    post(frame, { type: 'plannotator-bridge-resize', height: 1234 })
    await waitFor(() => expect(frame.style.height).toBe('1234px'))
  })

  it('reports a failed quick label with a toast instead of throwing', async () => {
    h.mutateAsync.mockRejectedValue(new Error('boom'))
    const frame = await mount()
    select(frame)
    fireEvent.click(await screen.findByRole('button', { name: 'Nice work' }))
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('boom'))
  })

  it('ignores a quick label while a comment is already being created', async () => {
    h.isPending = true
    const frame = await mount()
    select(frame)
    fireEvent.click(await screen.findByRole('button', { name: 'Nice work' }))
    expect(h.mutateAsync).not.toHaveBeenCalled()
  })

  it('stores no synthetic quote for an element-only pinpoint', async () => {
    h.mutateAsync.mockResolvedValue({ id: 1 })
    const frame = await mount()
    post(frame, {
      type: 'plannotator-bridge-ready',
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    })
    post(frame, {
      type: 'plannotator-bridge-selection',
      text: '[element: Image]',
      pinpoint: true,
      anchor: { selector: 'img', tagName: 'img' },
      rect: { top: 10, left: 10, width: 20, height: 20 },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Comment' }))
    fireEvent.change(await screen.findByPlaceholderText('Add a comment…'), {
      target: { value: 'needs alt text' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.mutateAsync).toHaveBeenCalled())
    const arg = h.mutateAsync.mock.calls[0]?.[0]
    expect(arg.anchor.originalText).toBe('')
    expect(arg.anchor.htmlAnchor.tagName).toBe('img')
  })
})
