import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/lib/api-ai-review'
import type { ReviewRun } from '@/lib/api-ai-review'
import { CrmError } from '@/lib/api-crm'
import { CustomerAiReviewTab } from './CustomerAiReviewTab'

vi.mock('@/lib/api-ai-review', async () => {
  const actual = await vi.importActual<typeof api>('@/lib/api-ai-review')
  return {
    ...actual,
    startReview: vi.fn(),
    getReviews: vi.fn(),
    getReviewRun: vi.fn(),
  }
})
vi.mock('@/components/documents/DocumentViewer', () => ({
  DocumentViewer: ({ id, embedded }: { id: number; embedded?: boolean }) => (
    <div>
      viewer {id} {String(embedded)}
    </div>
  ),
}))

const cite = [{ kind: 'ticket' as const, id: 'T-948', label: 'T-948' }]
const done: ReviewRun = {
  run_id: 5,
  customer_key: 'wc:1',
  status: 'done',
  created_at: new Date(Date.now() - 4 * 60_000).toISOString(),
  finished_at: new Date().toISOString(),
  model: 'claude-sonnet-5-5',
  steps: [],
  review: {
    headline: 'Cooling off after the SLU delay.',
    sentiment: {
      score: -1,
      trend: 'steady',
      reason: 'r',
      citations: [],
      unsupported: true,
    },
    open_issues: [
      {
        title: 'SLU unresulted',
        detail: 'd',
        severity: 'high',
        citations: cite,
      },
    ],
    shortfalls: [
      {
        title: 'Slow reply',
        detail: 'd',
        severity: 'medium',
        theme: 'communication',
        citations: cite,
      },
    ],
    strengths: [],
    next_steps: [],
  },
  tool_calls: [{ tool: 'customer_overview', args: {}, ok: true, size: 10 }],
  tool_call_count: 1,
  input_tokens: 1000,
  output_tokens: 100,
  cost_usd: 0.31,
  citations_dropped: 0,
  error: null,
  document_id: 42,
  document_code: 'CR-0001',
  names_scrubbed: 0,
  document_error: null,
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <CustomerAiReviewTab customerKey="wc:1" />
    </QueryClientProvider>
  )
}

describe('CustomerAiReviewTab', () => {
  beforeEach(() => vi.clearAllMocks())

  it('empty state offers Generate and shows live progress', async () => {
    vi.mocked(api.getReviews).mockResolvedValue({ latest: null, history: [] })
    vi.mocked(api.startReview).mockResolvedValue({
      run_id: 9,
      status: 'running',
    })
    vi.mocked(api.getReviewRun).mockResolvedValue({
      ...done,
      run_id: 9,
      status: 'running',
      review: null,
      document_id: null,
      steps: [
        { at: 't', tool: 'list_tickets', label: 'Listed support tickets' },
      ],
    })
    setup()
    await userEvent.click(
      await screen.findByRole('button', { name: /Generate review/ })
    )
    expect(api.startReview).toHaveBeenCalledWith('wc:1')
    expect(
      await screen.findByText('Listed support tickets')
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Working · started \d+ min ago/)
    ).toBeInTheDocument()
  })

  it('done with a document shows the summary and embeds the document', async () => {
    vi.mocked(api.getReviews).mockResolvedValue({ latest: done, history: [] })
    setup()
    expect(
      await screen.findByText('Cooling off after the SLU delay.')
    ).toBeInTheDocument()
    expect(screen.getByText(/Negative · steady/)).toBeInTheDocument()
    expect(
      screen.getByText(/1 open issue · 1 where we fell short/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/claude-sonnet-5-5 · 1 lookup · \$0\.31/)
    ).toBeInTheDocument()
    expect(screen.getByText('viewer 42 true')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /Open in Documents/ })
    ).toHaveAttribute('href', '#reports/documents?id=42')
  })

  it('done without a document asks for a regenerate and shows the error', async () => {
    vi.mocked(api.getReviews).mockResolvedValue({
      latest: {
        ...done,
        document_id: null,
        document_error: 'document publish failed',
      },
      history: [],
    })
    setup()
    expect(
      await screen.findByText(/No review document yet/)
    ).toBeInTheDocument()
    expect(screen.getByText(/document publish failed/)).toBeInTheDocument()
  })

  it('mounting mid-run then finishing shows the review', async () => {
    const runningRun = { ...done, status: 'running' as const, review: null }
    vi.mocked(api.getReviews)
      .mockResolvedValueOnce({
        latest: runningRun,
        history: [
          {
            run_id: 5,
            status: 'running',
            created_at: done.created_at,
            sentiment_score: null,
          },
        ],
      })
      .mockResolvedValue({
        latest: done,
        history: [
          {
            run_id: 5,
            status: 'done',
            created_at: done.created_at,
            sentiment_score: -1,
          },
        ],
      })
    vi.mocked(api.getReviewRun).mockResolvedValue(done)
    setup()
    expect(await screen.findByText(/Negative · steady/)).toBeInTheDocument()
  })

  it('failed run keeps the last good review visible', async () => {
    vi.mocked(api.getReviews).mockResolvedValue({
      latest: {
        ...done,
        run_id: 6,
        status: 'failed',
        review: null,
        error: 'AI service unavailable',
      },
      history: [
        {
          run_id: 6,
          status: 'failed',
          created_at: done.created_at,
          sentiment_score: null,
        },
        {
          run_id: 5,
          status: 'done',
          created_at: done.created_at,
          sentiment_score: -1,
        },
      ],
    })
    vi.mocked(api.getReviewRun).mockResolvedValue(done)
    setup()
    expect(
      await screen.findByText(/AI service unavailable/)
    ).toBeInTheDocument()
    expect(await screen.findByText('viewer 42 true')).toBeInTheDocument()
    expect(api.getReviewRun).toHaveBeenCalledWith(5)
  })

  it('not configured on 503', async () => {
    vi.mocked(api.getReviews).mockResolvedValue({ latest: null, history: [] })
    vi.mocked(api.startReview).mockRejectedValue(
      new CrmError(503, 'review_not_configured')
    )
    setup()
    await userEvent.click(
      await screen.findByRole('button', { name: /Generate review/ })
    )
    expect(
      await screen.findByText(/AI review not configured/)
    ).toBeInTheDocument()
  })
})
