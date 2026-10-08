import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as crm from '@/lib/api-crm'
import type { CustomerCrm } from '@/lib/api-crm'
import { CustomerCrmTab } from './CustomerCrmTab'

vi.mock('@/lib/api-crm', async () => {
  const actual = await vi.importActual<typeof crm>('@/lib/api-crm')
  return { ...actual, getCustomerCrm: vi.fn(), getCrmActivity: vi.fn() }
})

const base: CustomerCrm = {
  configured: true,
  emails_tried: ['k@x.example'],
  leads: [
    {
      id: 'lead_A',
      name: 'Valor',
      status: 'Active Customer',
      owner: 'Scott Joseph',
      url: 'https://app.close.com/lead/lead_A/',
      contacts: [],
      opportunities: [],
    },
  ],
  items: [
    {
      id: 'acti_3',
      type: 'note',
      at: '2026-09-04T10:00:00Z',
      direction: null,
      who: 'Scott Joseph',
      title: 'Call back Friday',
      preview: 'Call back Friday',
      lead_id: 'lead_A',
      lead_name: 'Valor',
      automated: false,
      support_thread_url: null,
    },
    {
      id: 'acti_1',
      type: 'email',
      at: '2026-09-02T10:00:00Z',
      direction: 'inbound',
      who: 'k@x.example',
      title: 'COA question',
      preview: 'Where is it',
      lead_id: 'lead_A',
      lead_name: 'Valor',
      automated: false,
      support_thread_url: null,
    },
  ],
  total: 2,
  page: 1,
  page_size: 50,
  counts: { email: 1, call: 0, sms: 0, meeting: 0, note: 1, automated: 3 },
  fetched_at: new Date().toISOString(),
  stale: false,
  refresh_throttled: false,
}

function setup(data: CustomerCrm | Error = base) {
  if (data instanceof Error)
    vi.mocked(crm.getCustomerCrm).mockRejectedValue(data)
  else vi.mocked(crm.getCustomerCrm).mockResolvedValue(data)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <CustomerCrmTab customerKey="wc:1" />
    </QueryClientProvider>
  )
}

describe('CustomerCrmTab', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the lead header and timeline newest first', async () => {
    setup()
    expect(await screen.findByText('Valor')).toBeInTheDocument()
    expect(screen.getByText('Active Customer')).toBeInTheDocument()
    expect(screen.getByText('Owner: Scott Joseph')).toBeInTheDocument()
    const rows = screen.getAllByRole('button', {
      name: /COA question|Call back Friday/,
    })
    expect(rows[0]).toHaveTextContent('Call back Friday')
  })

  it('type chip and automated toggle refetch with filters', async () => {
    setup()
    await screen.findByText('Valor')
    await userEvent.click(screen.getByRole('button', { name: /^Emails/ }))
    expect(crm.getCustomerCrm).toHaveBeenLastCalledWith(
      'wc:1',
      expect.objectContaining({ types: ['email'] })
    )
    await userEvent.click(
      screen.getByRole('switch', { name: /Show automated/ })
    )
    expect(crm.getCustomerCrm).toHaveBeenLastCalledWith(
      'wc:1',
      expect.objectContaining({ includeAutomated: true })
    )
  })

  it('refresh asks for refresh=true', async () => {
    setup()
    await screen.findByText('Valor')
    await userEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    expect(crm.getCustomerCrm).toHaveBeenLastCalledWith(
      'wc:1',
      expect.objectContaining({ refresh: true })
    )
  })

  it('opens the drill-down panel with the email body as text', async () => {
    vi.mocked(crm.getCrmActivity).mockResolvedValue({
      ...(base.items[1] as crm.CrmItem),
      messages: [
        {
          id: 'acti_1',
          at: '2026-09-02T10:00:00Z',
          direction: 'inbound',
          sender: 'k@x.example',
          to: ['forrest@accumarklabs.com'],
          cc: [],
          subject: 'COA question',
          body: '<b>not html</b>\nline two',
        },
      ],
    })
    setup()
    await userEvent.click(
      await screen.findByRole('button', { name: /COA question/ })
    )
    const panel = await screen.findByRole('dialog')
    expect(within(panel).getByText(/<b>not html<\/b>/)).toBeInTheDocument()
    expect(crm.getCrmActivity).toHaveBeenCalledWith('wc:1', 'acti_1', 'email')
  })

  it('empty, not configured and unreachable states', async () => {
    setup({ ...base, leads: [], items: [], total: 0 })
    expect(
      await screen.findByText(/No Close lead found for k@x.example/)
    ).toBeInTheDocument()
  })

  it('shows not configured on 503', async () => {
    setup(new crm.CrmError(503, 'crm_not_configured'))
    expect(await screen.findByText(/CRM not configured/)).toBeInTheDocument()
  })

  it('shows unreachable with retry on 502', async () => {
    setup(new crm.CrmError(502, 'crm_unavailable'))
    expect(await screen.findByText(/Close is unreachable/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument()
  })
})
