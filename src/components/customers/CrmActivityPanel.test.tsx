import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import * as crm from '@/lib/api-crm'
import type { CrmItem } from '@/lib/api-crm'
import { CrmActivityPanel } from './CrmActivityPanel'

vi.mock('@/lib/api-crm', async () => {
  const actual = await vi.importActual<typeof crm>('@/lib/api-crm')
  return { ...actual, getCrmActivity: vi.fn() }
})
vi.mock('@/components/flags/EntityFlagButton', () => ({
  EntityFlagButton: ({
    entityType,
    entityId,
  }: {
    entityType: string
    entityId: string
  }) => <button type="button">{`flag ${entityType} ${entityId}`}</button>,
}))

const full: CrmItem = {
  id: 'acti_1',
  type: 'email',
  at: '2026-10-01T10:00:00Z',
  direction: 'inbound',
  who: 'Kyle',
  title: 'Re: COA timing',
  preview: '',
  lead_id: 'lead_1',
  lead_name: 'Kyle Robertson',
  automated: false,
  support_thread_url: null,
}

function setup(item: CrmItem, viaFlag: number | null = null) {
  vi.mocked(crm.getCrmActivity).mockResolvedValue({
    ...full,
    messages: [],
    via_flag: viaFlag,
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <CrmActivityPanel customerKey="wc:1" item={item} onClose={vi.fn()} />
    </QueryClientProvider>
  )
}

describe('CrmActivityPanel', () => {
  it('has a Flag button for this item', () => {
    setup(full)
    expect(
      screen.getByRole('button', { name: 'flag crm_item wc:1|email|acti_1' })
    ).toBeInTheDocument()
  })

  it('fills the header from the detail when opened from a flag link', async () => {
    setup({ ...full, title: '', lead_name: '' }, 7)
    expect(await screen.findByText('Re: COA timing')).toBeInTheDocument()
    expect(screen.getByText(/because you're on flag #7/)).toBeInTheDocument()
  })

  it('a flag link without access says so', async () => {
    vi.mocked(crm.getCrmActivity).mockReset()
    vi.mocked(crm.getCrmActivity).mockRejectedValue(new crm.CrmError(403, null))
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <CrmActivityPanel
          customerKey="wc:1"
          item={{ ...full, title: '', lead_name: '' }}
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    )
    expect(
      await screen.findByText(/don't have access to this item/)
    ).toBeInTheDocument()
  })
})
