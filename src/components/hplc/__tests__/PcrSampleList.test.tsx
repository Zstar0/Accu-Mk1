import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { WorksheetListItem, WorksheetUser } from '@/lib/api'
import { buildPcrRunDoc } from '@/lib/pcr-worksheet'
import { PcrSampleList } from '@/components/hplc/PcrSampleList'

// The flag cell reads live flags and the SLA badge the lab clock; neither is
// under test here, so both render as nothing.
vi.mock('@/components/hplc/EndoWorksheetTable', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  FlagCell: () => null,
}))
vi.mock('@/components/hplc/SlaAgeIndicator', () => ({
  SlaAgeIndicator: () => null,
}))

// Per-row Made / Ran ticks, as on the endo table (Handler, 2026-09-23): the
// run-level boxes only ever set, so a single row is where a slip is undone.

type Item = WorksheetListItem['items'][number]
const item = (id: number, overrides: Partial<Item> = {}): Item => ({
  id,
  sample_id: `P-3001-S0${id}`,
  sample_uid: `mk1://pcr-${id}`,
  service_group_id: null,
  department_id: 2,
  department_name: 'Microbiology',
  group_name: '-',
  group_color: 'zinc',
  priority: 'normal',
  added_at: '2026-09-21T16:00:00Z',
  date_received: '2026-09-21T16:00:00Z',
  instrument_uid: null,
  instrument_id: null,
  assigned_analyst_id: null,
  assigned_analyst_email: null,
  notes: null,
  peptide_id: null,
  method_name: null,
  stamped_method_name: null,
  stamped_instrument_name: null,
  lims_sub_sample_pk: id,
  assignment_role: 'pcr',
  box_id: null,
  box_label: null,
  analyses: [
    {
      title: 'Rapid Sterility Screening (PCR)',
      keyword: 'STERILITY-PCR',
      peptide_name: null,
      method: null,
    },
  ],
  prep_status: 'ready',
  client_order_number: 'WP-8120',
  sample_identity: 'BPC-157',
  ...overrides,
})

const users: WorksheetUser[] = [
  {
    id: 2,
    email: 'guian@example.com',
    first_name: 'Guian',
    last_name: 'Hernandez',
  } as WorksheetUser,
]

function renderList(
  items: Item[],
  isCompleted = false,
  onUpdateItem = vi.fn()
) {
  const ws: WorksheetListItem = {
    id: 29,
    title: 'PCR 09/23/2026',
    status: isCompleted ? 'completed' : 'open',
    notes: null,
    assigned_analyst: 2,
    assigned_analyst_email: null,
    item_count: items.length,
    created_at: '2026-09-23T15:00:00Z',
    completed_at: null,
    items,
  }
  const doc = buildPcrRunDoc(ws, {
    analystName: '',
    calendar: null,
    printedAt: '',
    dueAtByItemId: new Map(),
    notes: '',
  })
  render(
    <PcrSampleList
      doc={doc}
      items={items}
      users={users}
      calendar={null}
      slaByKey={new Map()}
      slaLoading={false}
      slaError={false}
      isCompleted={isCompleted}
      onRemove={vi.fn()}
      onUpdateItem={onUpdateItem}
    />
  )
  return onUpdateItem
}

describe('PcrSampleList per-row ticks', () => {
  it('gives every sample a Made and a Ran tick, and the NPC none', () => {
    renderList([item(1), item(2)])
    expect(screen.getAllByRole('button', { name: 'Made' })).toHaveLength(2)
    expect(
      screen.getAllByRole('button', { name: 'Ran on QuantStudio' })
    ).toHaveLength(2)
    expect(screen.getByText('No-template control')).toBeTruthy()
  })

  it('ticks and unticks one row at a time', () => {
    const onUpdateItem = renderList([
      item(1),
      item(2, {
        made_at: '2026-09-23T17:00:00Z',
        made_by_user_id: 2,
        ran_at: '2026-09-23T18:00:00Z',
        ran_by_user_id: 2,
      }),
    ])
    const made = screen.getAllByRole('button', { name: 'Made' })
    const ran = screen.getAllByRole('button', { name: 'Ran on QuantStudio' })
    expect(made.map(b => b.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
    ])
    fireEvent.click(made[0] as HTMLElement)
    expect(onUpdateItem).toHaveBeenLastCalledWith(1, { made: true })
    fireEvent.click(ran[1] as HTMLElement)
    expect(onUpdateItem).toHaveBeenLastCalledWith(2, { ran: false })
    expect(onUpdateItem).toHaveBeenCalledTimes(2)
  })

  it('is read-only on a completed worksheet', () => {
    const onUpdateItem = renderList([item(1)], true)
    const made = screen.getByRole('button', { name: 'Made' })
    expect(made).toBeDisabled()
    fireEvent.click(made)
    expect(onUpdateItem).not.toHaveBeenCalled()
  })
})
