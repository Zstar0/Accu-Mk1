// src/components/documents/annotations/__tests__/CommentsPanel.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DocumentComment } from '@/lib/api-document-comments'
import { CommentsPanel } from '../CommentsPanel'

vi.mock('@/lib/api-document-comments', async orig => ({
  ...(await orig()),
  fetchDocumentCommentAttachmentUrl: vi.fn().mockResolvedValue(null),
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

function renderPanel(comments: DocumentComment[], unanchored: string[] = []) {
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
        onSelect={vi.fn()}
        onGlobalComment={vi.fn()}
        headings={[
          { id: 'pn-h-1', level: 1, text: 'Title' },
          { id: 'own', level: 2, text: 'Sub' },
        ]}
        onNavigateHeading={vi.fn()}
        me={{ id: 42 }}
        isAdmin={false}
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
    expect(screen.getByText('🔍 Verify this')).toBeInTheDocument()
    expect(screen.getByText('new words')).toBeInTheDocument()
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
