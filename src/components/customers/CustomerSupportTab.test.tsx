import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as support from '@/lib/api-support'
import type { CustomerSupport, SupportThread } from '@/lib/api-support'
import { CrmError } from '@/lib/api-crm'
import { CustomerSupportTab } from './CustomerSupportTab'

vi.mock('@/lib/api-support', async () => {
  const actual = await vi.importActual<typeof support>('@/lib/api-support')
  return { ...actual, getCustomerSupport: vi.fn(), getSupportThread: vi.fn() }
})

const waitingSince = new Date(Date.now() - 2 * 3600_000).toISOString()
const open: SupportThread = {
  id: 'th_b',
  ref: 'T-482',
  title: 'COA late',
  status: 'open',
  priority: 'urgent',
  labels: ['Lab'],
  assignee: 'Lauren',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-03T00:00:00Z',
  preview: 'Where is my COA',
  waiting_since: waitingSince,
  plain_url: 'https://app.plain.com/workspace/w_1/thread/th_b',
}
const done: SupportThread = {
  ...open,
  id: 'th_a',
  ref: 'T-100',
  title: 'Shipping label',
  status: 'done',
  priority: 'normal',
  labels: [],
  waiting_since: null,
  updated_at: '2026-08-01T00:00:00Z',
}
const base: CustomerSupport = {
  customer_key: 'wc:1',
  matched: 1,
  threads: [open, done],
  total: 2,
  page: 1,
  page_size: 50,
  counts: { open: 1, snoozed: 0, done: 1, waiting: 1 },
  last_contact_at: '2026-09-03T00:00:00Z',
  oldest_waiting_since: waitingSince,
  fetched_at: new Date().toISOString(),
  stale: false,
  refresh_throttled: false,
}

function setup(data: CustomerSupport | Error = base) {
  if (data instanceof Error)
    vi.mocked(support.getCustomerSupport).mockRejectedValue(data)
  else vi.mocked(support.getCustomerSupport).mockResolvedValue(data)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <CustomerSupportTab customerKey="wc:1" />
    </QueryClientProvider>
  )
}

describe('CustomerSupportTab', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the summary, waiting badge and rows newest first', async () => {
    setup()
    expect(
      await screen.findByText(/2 tickets · 1 open · 1 waiting on us/)
    ).toBeInTheDocument()
    expect(screen.getByText(/Waiting on us 2h/)).toBeInTheDocument()
    const rows = screen.getAllByRole('button', { name: /T-482|T-100/ })
    expect(rows[0]).toHaveTextContent('COA late')
    expect(rows[0]).toHaveTextContent('Urgent')
    expect(rows[1]).not.toHaveTextContent('Normal')
  })

  it('status chip refetches with the status filter', async () => {
    setup()
    await screen.findByText('COA late')
    await userEvent.click(screen.getByRole('button', { name: /^Done/ }))
    expect(support.getCustomerSupport).toHaveBeenLastCalledWith(
      'wc:1',
      expect.objectContaining({ statuses: ['done'] })
    )
  })

  it('refresh is one-shot', async () => {
    setup()
    await screen.findByText('COA late')
    await userEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    expect(support.getCustomerSupport).toHaveBeenLastCalledWith(
      'wc:1',
      expect.objectContaining({ refresh: true })
    )
    await userEvent.click(screen.getByRole('button', { name: /^Open/ }))
    expect(
      vi.mocked(support.getCustomerSupport).mock.lastCall?.[1]?.refresh
    ).toBeFalsy()
  })

  it('opens the conversation with internal notes marked and events as one-liners', async () => {
    vi.mocked(support.getSupportThread).mockResolvedValue({
      thread: open,
      entries: [
        {
          id: 'e1',
          at: '2026-09-02T00:00:00Z',
          kind: 'email',
          author: 'Kyle R',
          author_kind: 'customer',
          internal: false,
          subject: 'COA late',
          text: '<b>not html</b>\nline two',
        },
        {
          id: 'e2',
          at: '2026-09-02T01:00:00Z',
          kind: 'note',
          author: 'Lauren',
          author_kind: 'agent',
          internal: true,
          subject: null,
          text: 'Retest promised',
        },
        {
          id: 'e3',
          at: '2026-09-02T02:00:00Z',
          kind: 'event',
          author: 'Lauren',
          author_kind: 'agent',
          internal: false,
          subject: null,
          text: 'Marked done by Lauren',
        },
      ],
      fetched_at: new Date().toISOString(),
      stale: false,
    })
    setup()
    await userEvent.click(await screen.findByRole('button', { name: /T-482/ }))
    const panel = await screen.findByRole('dialog')
    expect(within(panel).getByText(/<b>not html<\/b>/)).toBeInTheDocument()
    expect(within(panel).getByText('Internal')).toBeInTheDocument()
    expect(
      within(panel)
        .getByText('Retest promised')
        .closest('[data-internal="true"]')
    ).not.toBeNull()
    expect(within(panel).getByText(/Marked done by Lauren/)).toBeInTheDocument()
    expect(panel.textContent).not.toContain(String.fromCharCode(0xfffd))
    expect(
      within(panel).getByText(/Marked done by Lauren · /)
    ).toBeInTheDocument()
    expect(
      within(panel).getByRole('link', { name: /Open in Plain/ })
    ).toHaveAttribute('href', open.plain_url)
    expect(support.getSupportThread).toHaveBeenCalledWith('wc:1', 'th_b', {
      refresh: false,
    })
  })

  it('shows the empty state', async () => {
    setup({
      ...base,
      threads: [],
      total: 0,
      counts: { open: 0, snoozed: 0, done: 0, waiting: 0 },
      last_contact_at: null,
      oldest_waiting_since: null,
    })
    expect(
      await screen.findByText('No support tickets for this customer.')
    ).toBeInTheDocument()
  })

  it('shows not configured on 503', async () => {
    setup(new CrmError(503, 'support_not_configured'))
    expect(
      await screen.findByText(/Support not configured/)
    ).toBeInTheDocument()
  })

  it('shows unavailable with retry on 502', async () => {
    setup(new CrmError(502, 'support_unavailable'))
    expect(await screen.findByText(/Plain unavailable/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument()
  })

  it('shows the stale notice', async () => {
    setup({
      ...base,
      stale: true,
      fetched_at: new Date(Date.now() - 4 * 60_000).toISOString(),
    })
    expect(
      await screen.findByText(
        /Plain is unavailable, showing data from 4 min ago/
      )
    ).toBeInTheDocument()
  })
})

describe('support conversation order', () => {
  const entry = (
    id: string,
    at: string,
    kind: 'email' | 'event' = 'email'
  ) => ({
    id,
    at,
    kind,
    author: 'A',
    author_kind: 'agent' as const,
    internal: false,
    subject: null,
    text: `text-${id}`,
  })
  const detail = {
    thread: open,
    entries: [
      entry('e1', '2026-09-02T00:00:00Z'),
      entry('e2', '2026-09-02T01:00:00Z', 'event'),
      entry('e3', '2026-09-02T02:00:00Z'),
    ],
    fetched_at: new Date().toISOString(),
    stale: false,
  }
  const KEY = 'mk1.supportConversationOrder'
  const order = (panel: HTMLElement) =>
    (panel.textContent ?? '').match(/text-e\d/g)

  async function openPanel() {
    vi.mocked(support.getSupportThread).mockResolvedValue(detail)
    setup()
    await userEvent.click(await screen.findByRole('button', { name: /T-482/ }))
    return screen.findByRole('dialog')
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('shows newest first by default, events included', async () => {
    const panel = await openPanel()
    await within(panel).findByText('text-e3')
    expect(order(panel)).toEqual(['text-e3', 'text-e2', 'text-e1'])
    expect(
      within(panel).getByRole('button', { name: /Newest first/ })
    ).toBeInTheDocument()
  })

  it('toggles to oldest first and persists', async () => {
    const panel = await openPanel()
    await userEvent.click(
      await within(panel).findByRole('button', { name: /Newest first/ })
    )
    expect(order(panel)).toEqual(['text-e1', 'text-e2', 'text-e3'])
    expect(
      within(panel).getByRole('button', { name: /Oldest first/ })
    ).toBeInTheDocument()
    expect(localStorage.getItem(KEY)).toBe('oldest')
  })

  it('restores oldest from storage', async () => {
    localStorage.setItem(KEY, 'oldest')
    const panel = await openPanel()
    await within(panel).findByText('text-e3')
    expect(order(panel)).toEqual(['text-e1', 'text-e2', 'text-e3'])
  })
})
