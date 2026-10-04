// src/components/documents/__tests__/DocumentViewer.edit.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentViewer } from '@/components/documents/DocumentViewer'

vi.mock('@/vendor/plannotator/bridge-script', () => ({
  BRIDGE_PROTOCOL_VERSION: 1,
  ANNOTATION_HIGHLIGHT_CSS: '',
}))

const replace = vi.hoisted(() => vi.fn())
const createRev = vi.hoisted(() => vi.fn())
const navigate = vi.hoisted(() => vi.fn())
const clear = vi.hoisted(() => vi.fn())
const setStatus = vi.hoisted(() => vi.fn())
let docStatus = 'draft'

vi.mock('@/services/documents', () => ({
  useDocument: () => ({
    data: {
      id: 10,
      code: 'ART-0001',
      revision: 2,
      title: 'Audit',
      status: docStatus,
      category_name: 'Artifact',
      author: 'F',
      co_author: null,
      updated_at: '2026-10-03',
      updated_by: null,
      effective_date: null,
      revisions: [
        { id: 9, revision: 1, status: 'active', created_at: '2026-10-01' },
        { id: 10, revision: 2, status: docStatus, created_at: '2026-10-03' },
      ],
      open_comment_count: 0,
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
  useReplaceDraftContent: () => ({ mutateAsync: replace }),
  useCreateRevision: () => ({ mutateAsync: createRev }),
  documentKeys: {
    detail: (id: number) => ['documents', 'detail', id],
    lists: ['documents', 'list'],
    content: (id: number) => ['documents', 'content', id],
  },
}))
vi.mock('@/components/flags/EntityFlagButton', () => ({
  EntityFlagButton: () => null,
}))
vi.mock('@/services/document-comments', () => ({
  useDocumentComments: () => ({
    data: {
      items: [
        {
          id: 5,
          number: 1,
          kind: 'suggestion',
          status: 'open',
          anchor: { originalText: 'hi' },
          suggested_text: 'hello',
          body: '',
          author: 'T',
          author_user_id: 1,
          author_agent: null,
          label: null,
          replies: [],
          attachments: [],
          created_at: '2026-10-03T10:00:00',
          updated_at: '',
          edited_at: null,
          resolved_at: null,
          resolved_by: null,
          code: 'ART-0001',
          document_id: 10,
          revision: 2,
          parent_id: null,
        },
      ],
      code: 'ART-0001',
      latest_revision: 2,
      open_count: 1,
    },
  }),
  useCommentLabels: () => ({ data: [] }),
  useCreateComment: () => ({ mutateAsync: vi.fn() }),
  usePatchComment: () => ({ mutateAsync: vi.fn() }),
  useDeleteComment: () => ({ mutate: vi.fn() }),
  useSetCommentStatus: () => ({ mutate: setStatus, mutateAsync: setStatus }),
}))
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({
      user: {
        id: 1,
        role: 'admin',
        email: 'f@x.io',
        first_name: 'Forrest',
        last_name: 'P',
      },
    }),
}))
vi.mock('@/store/ui-store', () => ({
  useUIStore: (sel: (s: unknown) => unknown) =>
    sel({ clearDocumentViewer: clear, navigateToDocument: navigate }),
}))

function frameSays(data: unknown) {
  const frame = screen.getByTitle('Audit') as HTMLIFrameElement
  window.dispatchEvent(
    new MessageEvent('message', {
      data,
      origin: 'null',
      source: frame.contentWindow ?? undefined,
    })
  )
}
const ready = () =>
  frameSays({ type: 'plannotator-bridge-ready', protocolVersion: 1 })

async function renderViewer() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocumentViewer id={10} />
    </QueryClientProvider>
  )
  await waitFor(() => expect(screen.getByTitle('Audit')).toBeInTheDocument())
  act(ready)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled()
  )
}

describe('DocumentViewer edit mode', { timeout: 20_000 }, () => {
  beforeEach(() => {
    replace.mockReset().mockResolvedValue({ id: 10 })
    createRev.mockReset().mockResolvedValue({ id: 11 })
    navigate.mockReset()
    clear.mockReset()
    setStatus.mockReset().mockResolvedValue({})
    docStatus = 'draft'
  })

  it('Save on a draft PUTs the stripped html in place', async () => {
    await renderViewer()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByText('Editing · unsaved')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    act(() =>
      frameSays({
        type: 'plannotator-bridge-serialized',
        html: '<!doctype html>\n<html data-theme="dark"><head><!--pn-inject--><style></style><!--/pn-inject--></head><body contenteditable="true"><p>edited</p></body></html>',
      })
    )
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith({
        id: 10,
        html: '<!doctype html>\n<html><head></head><body><p>edited</p></body></html>',
      })
    )
    await waitFor(() =>
      expect(screen.queryByText('Editing · unsaved')).toBeNull()
    )
  })

  it('Save on an active revision POSTs a new draft and navigates to it', async () => {
    docStatus = 'active'
    await renderViewer()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    act(() =>
      frameSays({
        type: 'plannotator-bridge-serialized',
        html: '<html><head></head><body><p>edited</p></body></html>',
      })
    )
    await waitFor(() =>
      expect(createRev).toHaveBeenCalledWith({
        code: 'ART-0001',
        html: '<html><head></head><body><p>edited</p></body></html>',
        author: 'Forrest P',
      })
    )
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(11))
  })

  it('asks before leaving with unsaved edits', async () => {
    await renderViewer()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }))
    expect(confirm).toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }))
    expect(clear).toHaveBeenCalled()
  })

  it('Apply sends apply-replacement, saves, then resolves; apply-failed only toasts', async () => {
    await renderViewer()
    fireEvent.click(screen.getByRole('button', { name: /Comments/ }))
    const frame = screen.getByTitle('Audit') as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow as Window, 'postMessage')
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }))
    expect(post).toHaveBeenCalledWith(
      { type: 'plannotator-bridge-apply-replacement', id: '5', text: 'hello' },
      '*'
    )
    act(() =>
      frameSays({
        type: 'plannotator-bridge-serialized',
        html: '<html><head></head><body><p>hello</p></body></html>',
        appliedId: '5',
      })
    )
    await waitFor(() => expect(replace).toHaveBeenCalled())
    await waitFor(() =>
      expect(setStatus).toHaveBeenCalledWith({ id: 5, status: 'resolved' })
    )
    setStatus.mockClear()
    act(() => frameSays({ type: 'plannotator-bridge-apply-failed', id: '5' }))
    expect(setStatus).not.toHaveBeenCalled()
  })

  const HTML = '<html><head></head><body><p>x</p></body></html>'

  async function applyOnActive() {
    docStatus = 'active'
    await renderViewer()
    fireEvent.click(screen.getByRole('button', { name: /Comments/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }))
    act(() =>
      frameSays({
        type: 'plannotator-bridge-serialized',
        html: HTML,
        appliedId: '5',
      })
    )
  }

  it('Apply on an active revision resolves BEFORE navigating', async () => {
    await applyOnActive()
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(11))
    expect(setStatus).toHaveBeenCalledWith({ id: 5, status: 'resolved' })
    expect(setStatus.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      navigate.mock.invocationCallOrder[0] ?? 0
    )
  })

  it('Apply still navigates when the resolve rejects', async () => {
    setStatus.mockRejectedValueOnce(new Error('x'))
    await applyOnActive()
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(11))
  })

  it('ignores an unsolicited serialized message', async () => {
    await renderViewer()
    act(() =>
      frameSays({
        type: 'plannotator-bridge-serialized',
        html: HTML,
        appliedId: '5',
      })
    )
    await new Promise(r => setTimeout(r, 50))
    expect(replace).not.toHaveBeenCalled()
    expect(createRev).not.toHaveBeenCalled()
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('double Save posts serialize once and saves once; a plain Save never resolves', async () => {
    await renderViewer()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const frame = screen.getByTitle('Audit') as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow as Window, 'postMessage')
    const save = screen.getByRole('button', { name: /Save/ })
    fireEvent.click(save)
    fireEvent.click(save)
    const serializes = () =>
      post.mock.calls.filter(
        c => (c[0] as { type: string }).type === 'plannotator-bridge-serialize'
      ).length
    expect(serializes()).toBe(1)
    act(() => frameSays({ type: 'plannotator-bridge-serialized', html: HTML }))
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.queryByText('Editing · unsaved')).toBeNull()
    )
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('Apply whose save rejects does not resolve', async () => {
    replace.mockRejectedValueOnce(new Error('nope'))
    await renderViewer()
    fireEvent.click(screen.getByRole('button', { name: /Comments/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }))
    act(() =>
      frameSays({
        type: 'plannotator-bridge-serialized',
        html: HTML,
        appliedId: '5',
      })
    )
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
    await new Promise(r => setTimeout(r, 50))
    expect(setStatus).not.toHaveBeenCalled()
  })
})
