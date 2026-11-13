import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'
import type * as SlaSubjects from '@/services/sla-subjects'
import type { WorksheetListItem } from '@/lib/api'
import { getHplcSheet } from '@/lib/api'
import { WorksheetDrawerItems } from '../WorksheetDrawerItems'
import { makeRow, makeSheet } from '../prep/__tests__/hplc-sheet-fixtures'

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  getHplcSheet: vi.fn(),
}))
vi.mock('@/services/sla-subjects', async importOriginal => ({
  ...(await importOriginal<typeof SlaSubjects>()),
  useSlaForSubjects: () => ({
    byKey: new Map(),
    isLoading: false,
    isError: false,
  }),
}))

describe('WorksheetDrawerItems', () => {
  it.todo(
    'renders sample ID, group badge (analysis), priority, tech email, instrument UID per item (WSHT-03)'
  )
  it.todo('calls onRemove when X button clicked (WSHT-05)')
  it.todo('shows reassign popover with other open worksheets (WSHT-06)')
  it.todo('calls onReassign with target worksheet ID (WSHT-06)')
  it.todo('renders empty state when no items')
  it.todo('hides action buttons in completed mode')
})

type Item = WorksheetListItem['items'][number]

const item = (over: Partial<Item>): Item =>
  ({
    id: 311,
    sample_id: 'P-0120-S01',
    sample_uid: 'uid-1',
    service_group_id: 1,
    department_id: null,
    department_name: null,
    group_name: 'HPLC',
    group_color: 'zinc',
    priority: 'normal',
    added_at: '2026-11-01T00:00:00Z',
    date_received: null,
    assigned_analyst_id: null,
    assigned_analyst_email: null,
    notes: null,
    assignment_kind: null,
    box_id: null,
    box_label: null,
    analyses: [
      {
        keyword: 'PURITY',
        title: 'Purity',
        peptide_name: 'BPC-157',
        method: null,
      },
    ],
    lims_sub_sample_pk: 8,
    peptide_id: 10,
    stamped_method_name: null,
    stamped_instrument_name: null,
    method_name: null,
    instrument_uid: 'uid-a',
    instrument_id: null,
    prep_status: 'ready',
    ...over,
  }) as Item

function renderItems(items: Item[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <WorksheetDrawerItems
        items={items}
        worksheetId={7}
        openWorksheets={[]}
        isCompleted={false}
        prepStartedItems={new Set()}
        onRemove={vi.fn()}
        onReassign={vi.fn()}
        onStartPrep={vi.fn()}
        instruments={[]}
        onUpdateItem={vi.fn()}
        onReorder={vi.fn()}
      />
    </QueryClientProvider>
  )
}

describe('WorksheetDrawerItems on an HPLC worksheet (D1)', () => {
  beforeEach(() => vi.mocked(getHplcSheet).mockReset())

  it("shows the sheet's instrument beside the select, and not set when it has none", async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(
      makeSheet([
        makeRow({ instrument_id: 3, instrument_name: 'HPLC 1290b' }),
        makeRow({
          item_id: 312,
          sample_id: 'P-0121-S01',
          instrument_id: null,
          instrument_name: null,
        }),
      ])
    )
    renderItems([item({}), item({ id: 312, sample_id: 'P-0121-S01' })])
    expect(
      await screen.findByText('Sheet instrument: HPLC 1290b')
    ).toBeInTheDocument()
    expect(screen.getByText('Sheet instrument: not set')).toBeInTheDocument()
    expect(getHplcSheet).toHaveBeenCalledTimes(1)
    expect(getHplcSheet).toHaveBeenCalledWith(7)
    expect(
      screen.getByRole('combobox', { name: 'P-0120-S01, Instrument' })
    ).toBeEnabled()
    expect(
      screen.queryByText('final: the prep is promoted')
    ).not.toBeInTheDocument()
  })

  it('a promoted row keeps its select but it is off, with the reason', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(
      makeSheet([makeRow({ promoted: true, instrument_name: 'HPLC 1290b' })])
    )
    renderItems([item({})])
    expect(
      await screen.findByText('final: the prep is promoted')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'P-0120-S01, Instrument' })
    ).toBeDisabled()
  })

  it('rows of other benches never read the sheet and render as before', async () => {
    const endo = item({
      analyses: [
        {
          keyword: 'ENDO',
          title: 'Endotoxin',
          peptide_name: null,
          method: null,
        },
      ],
    })
    const { container } = renderItems([endo])
    await waitFor(() => expect(screen.getByText('P-0120-S01')).toBeTruthy())
    expect(getHplcSheet).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Sheet instrument')
    // the select keeps no added name
    expect(
      screen.queryByRole('combobox', { name: 'P-0120-S01, Instrument' })
    ).toBeNull()
    for (const c of screen.getAllByRole('combobox')) expect(c).toBeEnabled()
  })
})
