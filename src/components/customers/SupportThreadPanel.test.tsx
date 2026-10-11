import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as support from '@/lib/api-support'
import type { SupportThread, SupportThreadDetail } from '@/lib/api-support'
import { CrmError } from '@/lib/api-crm'
import { SupportThreadPanel } from './SupportThreadPanel'

vi.mock('@/lib/api-support', async () => {
  const actual = await vi.importActual<typeof support>('@/lib/api-support')
  return {
    ...actual,
    getSupportThread: vi.fn(),
    getSupportMe: vi.fn(),
    getSupportWorkspace: vi.fn(),
    supportAction: vi.fn(),
  }
})

const thread: SupportThread = {
  id: 'th_b',
  ref: 'T-482',
  title: 'COA late',
  status: 'open',
  priority: 'normal',
  labels: ['Lab'],
  label_refs: [{ id: 'l_1', type_id: 'lt_1', name: 'Lab' }],
  assignee: null,
  assignee_id: null,
  customer_plain_id: 'c_1',
  created_at: null,
  updated_at: null,
  preview: '',
  waiting_since: null,
  plain_url: 'https://app.plain.com/x',
}
const detail: SupportThreadDetail = {
  thread: {
    ...thread,
    customer: {
      name: 'Kyle Robertson',
      email: 'k@x',
      external_id: null,
      avatar_url: null,
      company: null,
      created_at: null,
      updated_at: null,
      wp_profile_url: null,
    },
    assignees: [],
    fields: [],
  },
  entries: [],
  fetched_at: new Date().toISOString(),
  stale: false,
}

function setup(hasSeat = true) {
  vi.mocked(support.getSupportThread).mockResolvedValue(detail)
  vi.mocked(support.getSupportMe).mockResolvedValue({
    has_seat: hasSeat,
    plain_user_id: hasSeat ? 'u_1' : null,
    name: hasSeat ? 'Sam Parker' : null,
    email: hasSeat ? 'sam@accumark.example' : null,
    unavailable: false,
  })
  vi.mocked(support.getSupportWorkspace).mockResolvedValue({
    teammates: [{ plain_user_id: 'u_1', name: 'Sam Parker', email: 's@x' }],
    label_types: [{ id: 'lt_2', name: 'Shipping', color: null }],
  })
  vi.mocked(support.supportAction).mockResolvedValue({ detail })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <SupportThreadPanel
        customerKey="wc:1"
        thread={thread}
        onClose={vi.fn()}
      />
    </QueryClientProvider>
  )
}

const openReply = async () =>
  userEvent.click(await screen.findByRole('button', { name: /Reply to/ }))

describe('SupportThreadPanel actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('hides controls without a seat and explains why', async () => {
    setup(false)
    expect(
      await screen.findByText(/Replying needs a Plain account/)
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Send as/ })).toBeNull()
  })

  it('reply asks once, sends, and clears the draft', async () => {
    setup()
    await openReply()
    const box = await screen.findByRole('textbox', { name: /Reply/ })
    await userEvent.type(box, 'Thanks for waiting')
    await userEvent.click(
      screen.getByRole('button', { name: 'Send as Sam Parker' })
    )
    expect(support.supportAction).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Yes, send' }))
    await waitFor(() =>
      expect(support.supportAction).toHaveBeenCalledWith(
        'wc:1',
        'th_b',
        'reply',
        {
          markdown: 'Thanks for waiting',
        }
      )
    )
    await waitFor(() => expect(box).toHaveValue(''))
    expect(localStorage.getItem('mk1.supportDraft.th_b.reply')).toBeNull()
  })

  it('send is disabled when empty', async () => {
    setup()
    await openReply()
    expect(
      await screen.findByRole('button', { name: 'Send as Sam Parker' })
    ).toBeDisabled()
  })

  it('a failed reply keeps the draft and shows the reason', async () => {
    setup()
    await openReply()
    vi.mocked(support.supportAction).mockRejectedValueOnce(
      new CrmError(403, 'not_allowed_to_reply')
    )
    const box = await screen.findByRole('textbox', { name: /Reply/ })
    await userEvent.type(box, 'hello')
    await userEvent.click(
      screen.getByRole('button', { name: 'Send as Sam Parker' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Yes, send' }))
    expect(
      await screen.findByText(/hasn't allowed Mk1 to send as you/)
    ).toBeInTheDocument()
    expect(box).toHaveValue('hello')
  })

  it('note sends without confirmation', async () => {
    setup()
    await userEvent.click(
      await screen.findByRole('button', { name: 'Add note' })
    )
    await userEvent.type(
      screen.getByRole('textbox', { name: /Note/ }),
      'check COA'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Add internal note' })
    )
    await waitFor(() =>
      expect(support.supportAction).toHaveBeenCalledWith(
        'wc:1',
        'th_b',
        'note',
        {
          markdown: 'check COA',
        }
      )
    )
  })

  it('draft survives closing the panel', async () => {
    setup()
    await openReply()
    await userEvent.type(
      await screen.findByRole('textbox', { name: /Reply/ }),
      'half'
    )
    expect(localStorage.getItem('mk1.supportDraft.th_b.reply')).toBe('half')
  })

  it('an unconfirmed reply refetches the thread and drops the pending confirmation', async () => {
    setup()
    await openReply()
    vi.mocked(support.supportAction).mockRejectedValueOnce(
      new CrmError(504, 'reply_unconfirmed')
    )
    const box = await screen.findByRole('textbox', { name: /Reply/ })
    await userEvent.type(box, 'hello')
    await userEvent.click(
      screen.getByRole('button', { name: 'Send as Sam Parker' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Yes, send' }))
    expect(await screen.findByText(/Not confirmed/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Yes, send' })).toBeNull()
    await waitFor(() =>
      expect(
        vi.mocked(support.getSupportThread).mock.calls.length
      ).toBeGreaterThan(1)
    )
  })

  it('a reply that failed without a code is treated as unconfirmed, not as try again', async () => {
    setup()
    await openReply()
    vi.mocked(support.supportAction).mockRejectedValueOnce(
      new TypeError('Failed to fetch')
    )
    await userEvent.type(
      await screen.findByRole('textbox', { name: /Reply/ }),
      'hello'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Send as Sam Parker' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Yes, send' }))
    expect(await screen.findByText(/Not confirmed/)).toBeInTheDocument()
    expect(screen.queryByText(/Try again/)).toBeNull()
  })

  it('Ctrl+Enter never confirms a reply, even when held', async () => {
    setup()
    await openReply()
    const box = await screen.findByRole('textbox', { name: /Reply/ })
    await userEvent.type(box, 'hello')
    await userEvent.keyboard('{Control>}{Enter}{Enter}{Enter}{/Control}')
    expect(
      screen.getByRole('button', { name: 'Yes, send' })
    ).toBeInTheDocument()
    expect(support.supportAction).not.toHaveBeenCalled()
  })

  it('lays out Plain-style: action bar, sidebar, oldest first', async () => {
    setup()
    expect(
      await screen.findByRole('button', { name: 'Reply to Kyle' })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add note' })).toBeInTheDocument()
    expect(screen.getByText('Thread details')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Oldest first/ })
    ).toBeInTheDocument()
  })

  it('R and N open the composer, Esc closes it', async () => {
    setup()
    await screen.findByRole('button', { name: 'Add note' })
    await userEvent.keyboard('n')
    expect(
      await screen.findByRole('textbox', { name: /Note/ })
    ).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: /Note/ })).toBeNull()
    )
    await userEvent.keyboard('r')
    expect(
      await screen.findByRole('textbox', { name: /Reply/ })
    ).toBeInTheDocument()
  })

  it('R and N do nothing while typing', async () => {
    setup()
    await screen.findByRole('button', { name: 'Add note' })
    await userEvent.keyboard('r')
    const box = await screen.findByRole('textbox', { name: /Reply/ })
    await userEvent.type(box, 'rn')
    expect(box).toHaveValue('rn')
    expect(screen.queryByRole('textbox', { name: /Note/ })).toBeNull()
  })

  it('More offers waiting for customer', async () => {
    setup()
    await userEvent.click(await screen.findByRole('button', { name: 'More' }))
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Waiting for customer' })
    )
    await waitFor(() =>
      expect(support.supportAction).toHaveBeenCalledWith(
        'wc:1',
        'th_b',
        'status',
        { status: 'waiting_for_customer' }
      )
    )
  })
})
