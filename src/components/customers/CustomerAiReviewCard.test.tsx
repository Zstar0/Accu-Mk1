import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/lib/api-ai-review'
import type { ReviewRun } from '@/lib/api-ai-review'
import { CrmError } from '@/lib/api-crm'
import { CustomerAiReviewCard } from './CustomerAiReviewCard'

vi.mock('@/lib/api-ai-review', async () => {
  const actual = await vi.importActual<typeof api>('@/lib/api-ai-review')
  return {
    ...actual,
    startReview: vi.fn(),
    getReviews: vi.fn(),
    getReviewRun: vi.fn(),
  }
})
const navigateToSample = vi.fn()
vi.mock('@/store/ui-store', () => ({
  useUIStore: (sel: (s: unknown) => unknown) =>
    sel({ navigateToSample, navigateToOrderExplorer: vi.fn() }),
}))
vi.mock('./SupportThreadPanel', () => ({
  SupportThreadPanel: ({ thread }: { thread: { ref: string } | null }) =>
    thread ? <div role="dialog">Support panel {thread.ref}</div> : null,
}))
vi.mock('./CrmActivityPanel', () => ({
  CrmActivityPanel: () => null,
}))

const thread = { id: 'th_1', ref: 'T-948', title: 'COA late' }
const done: ReviewRun = {
  run_id: 5,
  customer_key: 'wc:1',
  status: 'done',
  created_at: new Date(Date.now() - 4 * 60_000).toISOString(),
  finished_at: new Date().toISOString(),
  model: 'claude-sonnet-5-5',
  steps: [],
  review: {
    sentiment: {
      score: 1,
      trend: 'steady',
      reason: 'Happy overall',
      citations: [],
      unsupported: true,
    },
    open_issues: [
      {
        text: 'Retest result not sent',
        citations: [{ kind: 'sample', id: 'P-2390', label: 'P-2390' }],
      },
    ],
    shortfalls: [
      {
        text: 'The reply on T-948 took 3 days',
        citations: [{ kind: 'ticket', id: 'T-948', label: 'T-948', thread }],
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
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <CustomerAiReviewCard customerKey="wc:1" />
    </QueryClientProvider>
  )
}

describe('CustomerAiReviewCard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('empty state offers Generate and starts a run', async () => {
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
  })

  it('done state shows sentiment, counts, sections and cost', async () => {
    vi.mocked(api.getReviews).mockResolvedValue({
      latest: done,
      history: [
        {
          run_id: 5,
          status: 'done',
          created_at: done.created_at,
          sentiment_score: 1,
        },
      ],
    })
    setup()
    expect(await screen.findByText(/Positive · steady/)).toBeInTheDocument()
    expect(
      screen.getByText(/1 open issue · 1 where we fell short/)
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Show details/ }))
    expect(
      screen.getByText('The reply on T-948 took 3 days')
    ).toBeInTheDocument()
    expect(
      screen.getByText(/claude-sonnet-5-5 · 1 lookup · \$0\.31/)
    ).toBeInTheDocument()
    expect(screen.getByText(/unsupported/i)).toBeInTheDocument()
  })

  it('citation chips open the support panel and the sample page', async () => {
    vi.mocked(api.getReviews).mockResolvedValue({ latest: done, history: [] })
    setup()
    await userEvent.click(
      await screen.findByRole('button', { name: /Show details/ })
    )
    await userEvent.click(screen.getByRole('button', { name: 'T-948' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Support panel T-948')
    await userEvent.click(screen.getByRole('button', { name: 'P-2390' }))
    expect(navigateToSample).toHaveBeenCalledWith('P-2390')
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
          sentiment_score: 1,
        },
      ],
    })
    vi.mocked(api.getReviewRun).mockResolvedValue(done)
    setup()
    expect(
      await screen.findByText(/AI service unavailable/)
    ).toBeInTheDocument()
    expect(await screen.findByText(/Positive · steady/)).toBeInTheDocument()
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

  it('show lookups lists the tool calls', async () => {
    vi.mocked(api.getReviews).mockResolvedValue({ latest: done, history: [] })
    setup()
    await userEvent.click(
      await screen.findByRole('button', { name: /Show details/ })
    )
    await userEvent.click(screen.getByRole('button', { name: /Show lookups/ }))
    expect(
      within(screen.getByRole('list', { name: 'Lookups' })).getByText(
        /customer_overview/
      )
    ).toBeInTheDocument()
  })
})
