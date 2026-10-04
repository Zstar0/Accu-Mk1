// src/components/documents/annotations/__tests__/CommentsPanel.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { DocumentComment } from '@/lib/api-document-comments'
import { CommentsPanel } from '../CommentsPanel'

vi.mock('@/lib/api-document-comments', async orig => ({
  ...(await orig()),
  fetchDocumentCommentAttachmentUrl: vi.fn().mockResolvedValue(null),
}))

const createAsync = vi.fn().mockResolvedValue({})
vi.mock('@/services/document-comments', () => ({
  useCreateComment: () => ({ mutateAsync: createAsync, mutate: vi.fn() }),
  usePatchComment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn() }),
  useDeleteComment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn() }),
  useSetCommentStatus: () => ({ mutateAsync: vi.fn(), mutate: vi.fn() }),
}))

const base = (over: Partial<DocumentComment>): DocumentComment => ({
  id: 1,
  code: 'ART-0001',
  document_id: 10,
  revision: 1,
  parent_id: null,
  number: 1,
  kind: 'comment',
  anchor: { originalText: 'quoted' },
  label: null,
  body: 'hello',
  suggested_text: null,
  author: 'Tess Tech',
  author_user_id: 42,
  author_agent: null,
  status: 'open',
  resolved_at: null,
  resolved_by: null,
  created_at: '2026-10-03T14:00:00',
  updated_at: '2026-10-03T14:00:00',
  edited_at: null,
  attachments: [],
  replies: [],
  ...over,
})
const labels = [
  {
    id: 'verify-this',
    emoji: '🔍',
    text: 'Verify this',
    color: 'orange',
    tip: null,
  },
]

interface Opts {
  isAdmin?: boolean
  me?: { id: number } | null
  onApply?: (c: DocumentComment) => void
  onSelect?: (id: string) => void
}
function renderPanel(
  comments: DocumentComment[],
  unanchored: string[] = [],
  o: Opts = {}
) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <CommentsPanel
        docId={10}
        currentRevision={2}
        comments={comments}
        labels={labels}
        filter="open"
        onFilterChange={vi.fn()}
        unanchoredIds={new Set(unanchored)}
        selectedId={null}
        onSelect={o.onSelect ?? vi.fn()}
        onGlobalComment={vi.fn()}
        headings={[
          { id: 'pn-h-1', level: 1, text: 'Title' },
          { id: 'own', level: 2, text: 'Sub' },
        ]}
        onNavigateHeading={vi.fn()}
        me={o.me === undefined ? { id: 42 } : o.me}
        isAdmin={o.isAdmin ?? false}
        onApply={o.onApply}
      />
    </QueryClientProvider>
  )
}

describe('CommentsPanel', () => {
  it('orders cards by number, shows the agent author and "on rN", and groups lost ones', () => {
    renderPanel(
      [
        base({
          id: 3,
          number: 3,
          author: 'jarvis',
          author_user_id: null,
          author_agent: 'jarvis',
          revision: 1,
        }),
        base({ id: 1, number: 1 }),
        base({ id: 2, number: 2, anchor: { originalText: 'gone' } }),
      ],
      ['2']
    )
    const cards = screen.getAllByTestId('comment-card')
    expect(cards.map(c => c.getAttribute('data-number'))).toEqual([
      '1',
      '3',
      '2',
    ])
    expect(
      within(cards[1] as HTMLElement).getByText('jarvis')
    ).toBeInTheDocument()
    expect(
      within(cards[1] as HTMLElement).getByText('on r1')
    ).toBeInTheDocument()
    const lost = screen.getByRole('region', { name: 'Lost its place' })
    expect(within(lost).getByText('“gone”')).toBeInTheDocument()
  })

  it('renders an element-only card without a quote', () => {
    renderPanel([
      base({
        anchor: {
          originalText: '',
          htmlAnchor: { selector: 'img', tagName: 'img' },
        },
      }),
    ])
    const card = screen.getByTestId('comment-card')
    expect(within(card).queryByText(/“/)).toBeNull()
    expect(within(card).getByText('img')).toBeInTheDocument()
  })

  it('shows a label chip with the catalog colour and a suggestion with its replacement', () => {
    renderPanel([
      base({ label: 'verify-this' }),
      base({
        id: 2,
        number: 2,
        kind: 'suggestion',
        body: '',
        suggested_text: 'new words',
        anchor: { originalText: 'old words' },
      }),
    ])
    const chip = screen.getByText('🔍 Verify this')
    expect(chip.style.backgroundColor).toBe('rgba(249, 115, 22, 0.15)')
    expect(chip.style.color).toBe('rgb(234, 88, 12)') // #ea580c, light theme
    expect(screen.getByText('new words')).toBeInTheDocument()
    expect(screen.getByText('Suggestion')).toBeInTheDocument()
    expect(screen.getByText(/Replace with:/)).toBeInTheDocument()
  })

  it('offers Edit/Delete to the author or an admin only', () => {
    const other = base({ author_user_id: 99 })
    const { unmount } = renderPanel([other])
    expect(screen.queryByLabelText('Edit')).toBeNull()
    expect(screen.queryByLabelText('Delete')).toBeNull()
    unmount()
    renderPanel([other], [], { isAdmin: true })
    expect(screen.getByLabelText('Edit')).toBeInTheDocument()
    expect(screen.getByLabelText('Delete')).toBeInTheDocument()
  })

  it('shows Apply only to an admin, on an open, placed suggestion', () => {
    const sug = base({ kind: 'suggestion', suggested_text: 'x' })
    const onApply = vi.fn()
    const { unmount } = renderPanel([sug], [], { onApply })
    expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull()
    unmount()
    const r2 = renderPanel([sug], [], { isAdmin: true })
    expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull()
    r2.unmount()
    const r3 = renderPanel([sug], ['1'], { isAdmin: true, onApply })
    expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull()
    r3.unmount()
    renderPanel([sug], [], { isAdmin: true, onApply })
    expect(screen.getByRole('button', { name: /Apply/ })).toBeInTheDocument()
  })

  it('does not select a lost card, but selects a placed one', async () => {
    const onSelect = vi.fn()
    renderPanel(
      [base({ id: 1, number: 1 }), base({ id: 2, number: 2 })],
      ['2'],
      { onSelect }
    )
    const [placed, lost] = screen.getAllByTestId('comment-card')
    await userEvent.click(lost as HTMLElement)
    expect(onSelect).not.toHaveBeenCalled()
    await userEvent.click(placed as HTMLElement)
    expect(onSelect).toHaveBeenCalledWith('1')
  })

  it('clears and closes the reply box after a successful reply', async () => {
    renderPanel([base({})])
    await userEvent.click(screen.getByLabelText('Reply'))
    await userEvent.type(screen.getByPlaceholderText('Reply…'), 'thanks')
    await userEvent.click(screen.getByText('Reply', { selector: 'button' }))
    expect(createAsync).toHaveBeenCalledWith({ parent_id: 1, body: 'thanks' })
    expect(screen.queryByPlaceholderText('Reply…')).toBeNull()
    await userEvent.click(screen.getByLabelText('Reply'))
    expect(screen.getByPlaceholderText('Reply…')).toHaveValue('')
  })

  it('the Contents tab lists headings indented by level', async () => {
    renderPanel([])
    const user = (await import('@testing-library/user-event')).default
    await user.click(screen.getByRole('tab', { name: 'Contents' }))
    const items = screen.getAllByRole('button', { name: /Title|Sub/ })
    expect(items).toHaveLength(2)
    expect(items[1]?.className).toContain('pl-5')
  })
})
