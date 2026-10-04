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
const toastError = vi.hoisted(() => vi.fn())
let docStatus = 'draft'
let viewedId = 10
let contentHtml = '<html><head></head><body><p>hi</p></body></html>'
let themeValue: 'light' | 'dark' = 'light'

vi.mock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), message: vi.fn() },
}))
vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ theme: themeValue, setTheme: vi.fn() }),
}))

vi.mock('@/services/documents', () => ({
  useDocument: () => ({
    data: {
      id: viewedId,
      code: 'ART-0001',
      revision: viewedId === 9 ? 1 : 2,
      title: 'Audit',
      status: docStatus,
      content_sha256: 'sha-10',
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
    data: contentHtml,
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

// The header Edit renders before any comment card's own Edit.
const editButton = () =>
  screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement
const serializeCount = (post: { mock: { calls: unknown[][] } }) =>
  post.mock.calls.filter(
    c => (c[0] as { type: string }).type === 'plannotator-bridge-serialize'
  ).length

async function renderViewer({ waitEnabled = true } = {}) {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <DocumentViewer id={viewedId} />
    </QueryClientProvider>
  )
  await waitFor(() => expect(screen.getByTitle('Audit')).toBeInTheDocument())
  act(ready)
  if (waitEnabled) await waitFor(() => expect(editButton()).toBeEnabled())
  return view
}

describe('DocumentViewer edit mode', { timeout: 20_000 }, () => {
  beforeEach(() => {
    replace.mockReset().mockResolvedValue({ id: 10 })
    createRev.mockReset().mockResolvedValue({ id: 11 })
    navigate.mockReset()
    clear.mockReset()
    setStatus.mockReset().mockResolvedValue({})
    toastError.mockReset()
    docStatus = 'draft'
    viewedId = 10
    contentHtml = '<html><head></head><body><p>hi</p></body></html>'
    themeValue = 'light'
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
        expectedSha256: 'sha-10',
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

  it('an unanswered Save never locks editing: Cancel, Edit, Save posts serialize again', async () => {
    await renderViewer()
    fireEvent.click(editButton())
    const first = screen.getByTitle('Audit') as HTMLIFrameElement
    const post1 = vi.spyOn(first.contentWindow as Window, 'postMessage')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(serializeCount(post1)).toBe(1)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)
    expect(screen.queryByText(/^Editing/)).toBeNull()
    // Cancel reloads the frame; the new one reports ready again.
    act(ready)
    await waitFor(() => expect(editButton()).toBeEnabled())
    fireEvent.click(editButton())
    const second = screen.getByTitle('Audit') as HTMLIFrameElement
    const post2 = vi.spyOn(second.contentWindow as Window, 'postMessage')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    expect(serializeCount(post2)).toBe(1)
  })

  it('a forged apply-failed with no pending apply is ignored', async () => {
    await renderViewer()
    fireEvent.click(editButton())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    act(() => frameSays({ type: 'plannotator-bridge-apply-failed', id: '5' }))
    expect(toastError).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Saving/ })).toBeDisabled()
    // The real answer is still honoured.
    act(() => frameSays({ type: 'plannotator-bridge-serialized', html: HTML }))
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
  })

  it('Edit and Apply are blocked on a revision that has a newer one', async () => {
    viewedId = 9
    docStatus = 'active'
    await renderViewer({ waitEnabled: false })
    const stale = 'A newer revision exists; edit that one'
    await waitFor(() => expect(editButton()).toHaveAttribute('title', stale))
    expect(editButton()).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Comments/ }))
    expect(await screen.findByRole('button', { name: 'Apply' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Newest revision/ }))
    expect(navigate).toHaveBeenCalledWith(10)
  })

  it('the newest revision keeps Edit enabled and offers no jump', async () => {
    await renderViewer()
    expect(editButton()).toBeEnabled()
    expect(screen.queryByRole('button', { name: /Newest revision/ })).toBeNull()
  })

  it('Edit stays disabled from a created revision until the navigate fires', async () => {
    let finishResolve: ((v: unknown) => void) | undefined
    setStatus.mockImplementation(
      () =>
        new Promise(r => {
          finishResolve = r
        })
    )
    await applyOnActive()
    await waitFor(() => expect(setStatus).toHaveBeenCalled())
    expect(navigate).not.toHaveBeenCalled()
    expect(editButton()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    await act(async () => finishResolve?.({}))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(11))
  })

  it('a theme flip during edit mode does not reload the frame', async () => {
    const view = await renderViewer()
    fireEvent.click(editButton())
    const frame = screen.getByTitle('Audit') as HTMLIFrameElement
    const before = frame.getAttribute('srcdoc')
    themeValue = 'dark'
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <DocumentViewer id={viewedId} />
      </QueryClientProvider>
    )
    expect(screen.getByTitle('Audit')).toBe(frame)
    expect(frame.getAttribute('srcdoc')).toBe(before)
    expect(screen.getByText(/^Editing/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      (screen.getByTitle('Audit') as HTMLIFrameElement).getAttribute('srcdoc')
    ).not.toBe(before)
  })

  it('Save on a script-bearing document confirms once; cancel posts nothing', async () => {
    contentHtml =
      '<html><head><script>document.body.append("x")</script></head><body><p>hi</p></body></html>'
    await renderViewer()
    fireEvent.click(editButton())
    const frame = screen.getByTitle('Audit') as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow as Window, 'postMessage')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    confirm.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(serializeCount(post)).toBe(0)
    expect(screen.getByText(/^Editing/)).toBeInTheDocument()
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(serializeCount(post)).toBe(1)
    expect(confirm).toHaveBeenCalledTimes(2)
    confirm.mockRestore()
  })

  it('Save on a document without scripts does not confirm', async () => {
    await renderViewer()
    fireEvent.click(editButton())
    const confirm = vi.spyOn(window, 'confirm').mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRestore()
  })
})
