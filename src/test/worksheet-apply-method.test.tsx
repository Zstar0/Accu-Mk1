/**
 * Task 6 (methods bench-stamping): the worksheet drawer's "apply run
 * context" bar (method + instrument -> Apply to all), the stamped-name
 * display precedence on the items list, and the native (id-keyed)
 * instrument select for non-HPLC items.
 *
 * Mounts the real WorksheetDrawer (react-query + zustand ui-store, per the
 * drawer's existing style) rather than stubbing it out, since the apply bar
 * lives directly in WorksheetDrawer.tsx and needs the full method/instrument
 * query wiring exercised. Downstream leaf-hook fetches unrelated to this
 * task (SLA status/service-groups/tiers used by WorksheetDrawerItems' SLA
 * indicator) are still mocked so they don't make real network calls in
 * jsdom — same reasoning as worksheets-inbox-lanes.test.tsx, just via api
 * mocks instead of component stubs since WorksheetDrawerItems itself is
 * under test here (display precedence).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type * as ApiModule from '@/lib/api'
import type { WorksheetListItem, HplcMethod, Instrument } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    listWorksheets: vi.fn(),
    getWorksheetUsers: vi.fn(),
    getInstruments: vi.fn(),
    getMethods: vi.fn(),
    applyWorksheetMethodInstrument: vi.fn(),
    getServiceGroups: vi.fn(),
    getSlaTiers: vi.fn(),
    getSlaPriorityTiers: vi.fn(),
    fetchSlaStatuses: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import {
  listWorksheets,
  getWorksheetUsers,
  getInstruments,
  getMethods,
  applyWorksheetMethodInstrument,
  getServiceGroups,
  getSlaTiers,
  getSlaPriorityTiers,
  fetchSlaStatuses,
} from '@/lib/api'
import { toast } from 'sonner'
import { useUIStore } from '@/store/ui-store'
import WorksheetDrawer from '@/components/hplc/WorksheetDrawer'

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const INSTRUMENT_7900F: Instrument = {
  id: 3,
  name: '7900F',
  senaite_id: null,
  senaite_uid: null,
  instrument_type: null,
  brand: null,
  model: null,
  active: true,
  department_id: null,
  origin: 'native',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const METHOD_ICP: HplcMethod = {
  id: 10,
  name: 'ICP-MS Metals',
  senaite_id: null,
  instrument_ids: [3],
  instruments: [{ id: 3, name: '7900F', model: null }],
  size_peptide: null,
  starting_organic_pct: null,
  temperature_mct_c: null,
  dissolution: null,
  notes: null,
  code: 'ICP-MS F',
  technique: null,
  department_id: null,
  reference: null,
  procedure_summary: null,
  supersedes_id: null,
  origin: 'native',
  active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  common_peptides: [],
  services: [{ analysis_service_id: 1, keyword: 'Pb', title: 'Lead', is_default: true }],
}

const ITEM_BASE = {
  sample_uid: 'uid-base',
  service_group_id: 1,
  department_name: null,
  group_name: 'ICP-MS',
  group_color: 'zinc',
  priority: 'normal',
  added_at: '2026-01-01T00:00:00Z',
  date_received: null,
  assigned_analyst_id: null,
  assigned_analyst_email: null,
  notes: null,
  assignment_kind: null,
  box_id: null,
  box_label: null,
  analyses: [],
}

const ITEM_STAMPED: WorksheetListItem['items'][number] = {
  ...ITEM_BASE,
  id: 1,
  sample_id: 'P-9200-S01',
  lims_sub_sample_pk: 7,
  peptide_id: null,
  stamped_method_name: 'ICP-MS F',
  stamped_instrument_name: '7900F',
  method_name: null,
  instrument_uid: null,
  instrument_id: 3,
  prep_status: 'ready',
}

const ITEM_HPLC: WorksheetListItem['items'][number] = {
  ...ITEM_BASE,
  id: 2,
  sample_id: 'P-9300-S01',
  lims_sub_sample_pk: 8,
  peptide_id: 44,
  stamped_method_name: null,
  stamped_instrument_name: null,
  method_name: 'Method 2',
  instrument_uid: 'uid-a',
  instrument_id: null,
  prep_status: 'ready',
}

const WORKSHEET: WorksheetListItem = {
  id: 1,
  title: 'WS-1',
  status: 'open',
  notes: null,
  assigned_analyst: null,
  // WorksheetDrawer defaults its analyst filter to the logged-in user's
  // email ('' when no auth user in this test), then filters open
  // worksheets by that value — match it here so auto-select finds this one.
  assigned_analyst_email: '',
  item_count: 2,
  created_at: '2026-01-01T00:00:00Z',
  completed_at: null,
  items: [ITEM_STAMPED, ITEM_HPLC],
}

const WORKSHEET_B: WorksheetListItem = {
  ...WORKSHEET,
  id: 2,
  title: 'WS-2',
  item_count: 0,
  items: [],
}

describe('WorksheetDrawer — run-context apply + stamped display + native instrument select', () => {
  beforeEach(() => {
    vi.mocked(listWorksheets).mockReset().mockResolvedValue([WORKSHEET])
    vi.mocked(getWorksheetUsers).mockReset().mockResolvedValue([])
    vi.mocked(getInstruments).mockReset().mockResolvedValue([INSTRUMENT_7900F])
    vi.mocked(getMethods).mockReset().mockResolvedValue([METHOD_ICP])
    vi.mocked(applyWorksheetMethodInstrument).mockReset()
    vi.mocked(getServiceGroups).mockReset().mockResolvedValue([])
    vi.mocked(getSlaTiers).mockReset().mockResolvedValue([])
    vi.mocked(getSlaPriorityTiers).mockReset().mockResolvedValue([])
    vi.mocked(fetchSlaStatuses).mockReset().mockResolvedValue([])
    vi.mocked(toast.success).mockReset()
    vi.mocked(toast.error).mockReset()
    useUIStore.getState().openWorksheetDrawer(1)
  })

  it('renders stamped method over the derived one, keeps HPLC derivation', async () => {
    render(<WorksheetDrawer />, { wrapper })
    expect(await screen.findByText('ICP-MS F')).toBeInTheDocument()
    expect(screen.getByText('Method 2')).toBeInTheDocument()
  })

  it('applies a run context to the worksheet', async () => {
    vi.mocked(applyWorksheetMethodInstrument).mockResolvedValue({
      stamped: 3,
      items_updated: 2,
      skipped_state: [],
      skipped_uncovered: [],
    })
    const user = userEvent.setup()
    render(<WorksheetDrawer />, { wrapper })

    // Radix Select doesn't fire change from userEvent's full pointer-event
    // sequence under jsdom (hasPointerCapture isn't implemented there) —
    // fireEvent.click sidesteps it, same workaround as
    // analysis-profiles-fulfillment.test.tsx / sla-pane.test.tsx.
    fireEvent.click(await screen.findByRole('combobox', { name: /method/i }))
    fireEvent.click(await screen.findByRole('option', { name: /icp-ms f/i }))

    fireEvent.click(await screen.findByRole('combobox', { name: /instrument/i }))
    fireEvent.click(await screen.findByRole('option', { name: /7900f/i }))

    await user.click(screen.getByRole('button', { name: /apply to all/i }))

    await waitFor(() =>
      expect(applyWorksheetMethodInstrument).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({ instrument_id: expect.any(Number) })
      )
    )
    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toContain('3')
  })

  it('summarizes skipped locked and uncovered counts in the success toast', async () => {
    vi.mocked(applyWorksheetMethodInstrument).mockResolvedValue({
      stamped: 1,
      items_updated: 1,
      skipped_state: [{ analysis_id: 5, review_state: 'verified' }],
      skipped_uncovered: [{ analysis_id: 6, keyword: 'As' }],
    })
    const user = userEvent.setup()
    render(<WorksheetDrawer />, { wrapper })

    fireEvent.click(await screen.findByRole('combobox', { name: /method/i }))
    fireEvent.click(await screen.findByRole('option', { name: /icp-ms f/i }))
    fireEvent.click(await screen.findByRole('combobox', { name: /instrument/i }))
    fireEvent.click(await screen.findByRole('option', { name: /7900f/i }))
    await user.click(screen.getByRole('button', { name: /apply to all/i }))

    await waitFor(() => expect(applyWorksheetMethodInstrument).toHaveBeenCalled())
    const message = vi.mocked(toast.success).mock.calls[0]?.[0] as string
    expect(message).toContain('1 locked')
    expect(message).toContain('1 not covered by this method')
  })

  it('resets the armed run context on worksheet switch, but not on a same-worksheet apply', async () => {
    vi.mocked(listWorksheets).mockResolvedValue([WORKSHEET, WORKSHEET_B])
    vi.mocked(applyWorksheetMethodInstrument).mockResolvedValue({
      stamped: 1,
      items_updated: 1,
      skipped_state: [],
      skipped_uncovered: [],
    })
    render(<WorksheetDrawer />, { wrapper })

    fireEvent.click(await screen.findByRole('combobox', { name: /method/i }))
    fireEvent.click(await screen.findByRole('option', { name: /icp-ms f/i }))
    fireEvent.click(await screen.findByRole('combobox', { name: /instrument/i }))
    fireEvent.click(await screen.findByRole('option', { name: /7900f/i }))
    expect(screen.getByRole('button', { name: /apply to all/i })).toBeEnabled()

    // Sticky within the SAME worksheet: a successful apply must not clear
    // the armed selections (repeat-apply convenience).
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /apply to all/i }))
    await waitFor(() => expect(applyWorksheetMethodInstrument).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: /apply to all/i })).toBeEnabled()

    // Switch the active worksheet — same store action the real worksheet
    // switcher's onValueChange calls (setActiveId -> setActiveWorksheetId).
    act(() => {
      useUIStore.getState().setActiveWorksheetId(2)
    })

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /method/i })).toHaveTextContent('Method…')
    )
    expect(screen.getByRole('combobox', { name: /instrument/i })).toHaveTextContent('Instrument…')
    expect(screen.getByRole('button', { name: /apply to all/i })).toBeDisabled()

    // Stale context can't be one-click applied to the new worksheet.
    await user.click(screen.getByRole('button', { name: /apply to all/i }))
    expect(applyWorksheetMethodInstrument).toHaveBeenCalledTimes(1)
  })
})
