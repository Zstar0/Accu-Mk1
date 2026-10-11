import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as support from '@/lib/api-support'
import type { SupportThread } from '@/lib/api-support'
import { TicketSidebar } from './TicketSidebar'

vi.mock('@/lib/api-support', async () => {
  const actual = await vi.importActual<typeof support>('@/lib/api-support')
  return { ...actual, getSupportWorkspace: vi.fn() }
})

const thread: SupportThread = {
  id: 'th_b',
  ref: 'T-1540',
  title: 'Contact form',
  status: 'open',
  priority: 'high',
  labels: ['Engineering'],
  label_refs: [{ id: 'l_1', type_id: 'lt_1', name: 'Engineering' }],
  assignee: 'Forrest Parker',
  assignee_id: 'u_1',
  customer_plain_id: 'c_1',
  created_at: null,
  updated_at: null,
  preview: '',
  waiting_since: null,
  plain_url: 'https://p/x',
  status_detail: {
    kind: 'needs_next_response',
    label: 'Needs next response',
    until: null,
  },
  assignees: [
    {
      plain_user_id: 'u_1',
      name: 'Forrest Parker',
      avatar_url: null,
      primary: true,
    },
    {
      plain_user_id: 'u_2',
      name: 'Lauren Hamilton',
      avatar_url: null,
      primary: false,
    },
  ],
  tier: { name: 'Regular Support', color: '#3b82f6' },
  fields: [
    { key: 'verification_code', label: 'Verification Code', value: null },
    { key: 'wp_user_id', label: 'WP User ID', value: '3173' },
    { key: 'total_orders', label: 'Total Orders', value: '2' },
    { key: 'total_spent', label: 'Total Spent', value: '$160.00' },
    { key: 'company', label: 'Company', value: null },
    { key: 'sales_rep', label: 'Sales Rep', value: 'Scott' },
  ],
  customer: {
    name: 'Lilia Billones',
    email: 'lilia@example.com',
    external_id: '3173',
    avatar_url: null,
    company: null,
    created_at: '2026-08-25T00:00:00Z',
    updated_at: '2026-08-25T00:00:00Z',
    wp_profile_url:
      'https://accumarklabs.com/wp-admin/user-edit.php?user_id=3173',
  },
}
const other: SupportThread = {
  ...thread,
  id: 'th_a',
  ref: 'T-1500',
  title: 'Older one',
  status: 'done',
}

function setup(canEdit = true) {
  vi.mocked(support.getSupportWorkspace).mockResolvedValue({
    teammates: [
      { plain_user_id: 'u_1', name: 'Forrest Parker', email: 'f@x' },
      { plain_user_id: 'u_2', name: 'Lauren Hamilton', email: 'l@x' },
      { plain_user_id: 'u_3', name: 'Scott Joseph', email: 's@x' },
    ],
    label_types: [{ id: 'lt_2', name: 'Shipping', color: null }],
  })
  const run = vi.fn().mockResolvedValue(undefined)
  const onSelect = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <TicketSidebar
        thread={thread}
        threads={[thread, other]}
        canEdit={canEdit}
        run={run}
        onSelect={onSelect}
      />
    </QueryClientProvider>
  )
  return { run, onSelect }
}

const ready = async (label: string) => {
  const el = await screen.findByLabelText(label)
  await waitFor(() => expect(el).toBeEnabled())
  return el
}

describe('TicketSidebar', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows Plain details, tier, the first fields and the customer', async () => {
    setup()
    expect(screen.getByText('Regular Support')).toBeInTheDocument()
    expect(screen.getByText('3173', { selector: 'dd' })).toBeInTheDocument()
    expect(screen.queryByText('Sales Rep')).toBeNull()
    await userEvent.click(
      screen.getByRole('button', { name: 'Show more fields' })
    )
    expect(screen.getByText('Sales Rep')).toBeInTheDocument()
    expect(screen.getByText('lilia@example.com')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '3173' })).toHaveAttribute(
      'href',
      thread.customer?.wp_profile_url
    )
  })

  it('status menu includes waiting for customer', async () => {
    const { run } = setup()
    await userEvent.selectOptions(await ready('Status'), 'waiting_for_customer')
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith('status', {
        status: 'waiting_for_customer',
      })
    )
  })

  it('adds and removes additional assignees', async () => {
    const { run } = setup()
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Remove assignee Lauren Hamilton',
      })
    )
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith('assignees', { remove: ['u_2'] })
    )
    await userEvent.selectOptions(await ready('Add assignee'), 'u_3')
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith('assignees', { add: ['u_3'] })
    )
  })

  it('priority and labels still call their actions', async () => {
    const { run } = setup()
    await userEvent.selectOptions(await ready('Priority'), 'urgent')
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith('priority', { priority: 'urgent' })
    )
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove label Engineering' })
    )
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith('labels', { remove: ['l_1'] })
    )
  })

  it('recent threads switch the ticket', async () => {
    const { onSelect } = setup()
    await userEvent.click(screen.getByRole('button', { name: /T-1500/ }))
    expect(onSelect).toHaveBeenCalledWith(other)
  })

  it('is read-only without a seat', () => {
    setup(false)
    expect(screen.queryByLabelText('Status')).toBeNull()
    expect(screen.getByText('Needs next response')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove label/ })).toBeNull()
  })

  it('shows a snooze end date in local time', () => {
    const until = '2026-10-12T02:00:00Z'
    vi.mocked(support.getSupportWorkspace).mockResolvedValue({
      teammates: [],
      label_types: [],
    })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <TicketSidebar
          thread={{
            ...thread,
            status: 'snoozed',
            status_detail: {
              kind: 'waiting_until',
              label: 'Waiting until 2026-10-12',
              until,
            },
          }}
          threads={[]}
          canEdit={false}
          run={vi.fn()}
          onSelect={vi.fn()}
        />
      </QueryClientProvider>
    )
    const local = new Date(until).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    })
    expect(screen.getByText(`Waiting until ${local}`)).toBeInTheDocument()
  })
})
