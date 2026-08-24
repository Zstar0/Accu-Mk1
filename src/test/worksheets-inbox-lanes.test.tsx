/**
 * WorksheetsInboxPage's bench-filter chips (spec 4, Task 10): before this
 * task the chips were two hardcoded buttons (HPLC / Microbiology) — an hm
 * (Heavy Metals) vial had NO reachable filter chip in this UI at all, even
 * though hm shipped as a catalog role back in spec-3. This file pins the
 * regression fix: chips are built from GET /worksheets/inbox/lanes
 * (useInboxLanes), so a new lane is reachable with zero FE code change.
 *
 * Heavy sub-components (WorksheetDropPanel, InboxVialCard, InboxFamilyGroup)
 * are stubbed — this file only exercises the chip row, the stored-role
 * fallback, and the empty-state copy, all of which render regardless of
 * vial/worksheet content.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DragOverlay: () => null,
}))

vi.mock('@/components/hplc/WorksheetDropPanel', () => ({
  WorksheetDropPanel: () => <div data-testid="worksheet-drop-panel" />,
}))
vi.mock('@/components/hplc/InboxVialCard', () => ({
  InboxVialCard: () => <div />,
}))
vi.mock('@/components/hplc/InboxFamilyGroup', () => ({
  InboxFamilyGroup: () => <div />,
}))

import {
  getInboxSamples,
  getInboxLanes,
  getWorksheetUsers,
  getVialRoles,
  fetchSampleAggregates,
  listWorksheets,
  type InboxLaneRow,
  type InboxResponse,
  type InboxVialItem,
  type VialRoleRow,
} from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getInboxSamples: vi.fn(),
    getInboxLanes: vi.fn(),
    getWorksheetUsers: vi.fn(),
    getVialRoles: vi.fn(),
    fetchSampleAggregates: vi.fn(),
    listWorksheets: vi.fn(),
  }
})

import WorksheetsInboxPage from '@/components/hplc/WorksheetsInboxPage'

const mockGetInboxSamples = vi.mocked(getInboxSamples)
const mockGetInboxLanes = vi.mocked(getInboxLanes)
const mockGetWorksheetUsers = vi.mocked(getWorksheetUsers)
const mockGetVialRoles = vi.mocked(getVialRoles)
const mockFetchSampleAggregates = vi.mocked(fetchSampleAggregates)
const mockListWorksheets = vi.mocked(listWorksheets)

const ROLE_ROWS: VialRoleRow[] = [
  { id: 1, code: 'hplc', label: 'HPLC', department_id: 1, boxable: true,
    variance_eligible: true, sort_order: 0, frozen: true, is_system: true },
  { id: 2, code: 'endo', label: 'Endotoxin', department_id: 2, boxable: true,
    variance_eligible: true, sort_order: 1, frozen: true, is_system: true },
  { id: 3, code: 'ster', label: 'Sterility', department_id: 2, boxable: true,
    variance_eligible: true, sort_order: 2, frozen: true, is_system: true },
  { id: 6, code: 'fentanyl', label: 'Fentanyl Screening', department_id: 1,
    boxable: false, variance_eligible: false, sort_order: 5, frozen: false,
    is_system: false },
]

const LANES: InboxLaneRow[] = [
  { key: 'hplc', label: 'Analytical', role_codes: ['hplc'], sort_order: 0 },
  { key: 'microbiology', label: 'Microbiology', role_codes: ['endo', 'ster'], sort_order: 1 },
  { key: 'hm', label: 'Heavy Metals', role_codes: ['hm'], sort_order: 3 },
]

const EMPTY_INBOX: InboxResponse = { items: [], total: 0, filter_role: null }

const STORAGE_ROLE_KEY = 'accu_mk1_worksheet_inbox_role'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <WorksheetsInboxPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  mockGetInboxLanes.mockResolvedValue(LANES)
  mockGetInboxSamples.mockResolvedValue(EMPTY_INBOX)
  mockGetWorksheetUsers.mockResolvedValue([])
  mockGetVialRoles.mockResolvedValue(ROLE_ROWS)
  mockFetchSampleAggregates.mockResolvedValue({ aggregates: {} })
  mockListWorksheets.mockResolvedValue([])
})

function _vial(uid: string, roleTags: string[] | undefined,
               role: string): InboxVialItem {
  return {
    uid, sample_id: `${uid}-S01`, is_parent: false, parent_sample_id: uid,
    assignment_role: role, assignment_kind: null, vial_sequence: 1,
    vial_total: 1, title: 'Test Peptide', client_id: null,
    client_order_number: null, date_received: null,
    review_state: 'sample_received', priority: 'normal',
    assignment_summary: '', analyses: [], role_tags: roleTags,
  }
}

describe('WorksheetsInboxPage — catalog-driven lane chips (Task 10)', () => {
  it('renders a chip for every lane, including hm — previously unreachable from this UI', async () => {
    renderPage()
    expect(await screen.findByRole('button', { name: 'Analytical' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Microbiology' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Heavy Metals' })).toBeInTheDocument()
  })

  it('lands on the first lane (sort_order) by default and fetches the inbox with that lane key', async () => {
    renderPage()
    await screen.findByRole('button', { name: 'Analytical' })
    await waitFor(() =>
      expect(mockGetInboxSamples).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'hplc' }),
      ),
    )
  })

  it('falls back to the first lane when the stored role no longer exists, and persists the correction', async () => {
    window.localStorage.setItem(STORAGE_ROLE_KEY, 'a_deleted_department')
    renderPage()
    await screen.findByRole('button', { name: 'Analytical' })
    await waitFor(() =>
      expect(mockGetInboxSamples).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'hplc' }),
      ),
    )
    await waitFor(() =>
      expect(window.localStorage.getItem(STORAGE_ROLE_KEY)).toBe('hplc'),
    )
  })

  it('clicking the Heavy Metals chip switches the active lane and refetches with its key', async () => {
    renderPage()
    const hmChip = await screen.findByRole('button', { name: 'Heavy Metals' })
    fireEvent.click(hmChip)
    await waitFor(() =>
      expect(mockGetInboxSamples).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'hm' }),
      ),
    )
  })

  it('empty-state copy names the current lane and the other lanes, by label', async () => {
    renderPage()
    await screen.findByRole('button', { name: 'Analytical' })
    expect(await screen.findByText('No Analytical vials waiting')).toBeInTheDocument()
    const hint = screen.getByText(/Switch to/i)
    expect(hint).toHaveTextContent('Microbiology')
    expect(hint).toHaveTextContent('Heavy Metals')
  })

  it('shows a retry affordance (not a permanent skeleton) when the lanes fetch fails', async () => {
    mockGetInboxLanes.mockRejectedValue(new Error('boom'))
    renderPage()
    const retryButtons = await screen.findAllByRole('button', { name: /retry/i })
    expect(retryButtons.length).toBeGreaterThan(0)
  })
})

describe('WorksheetsInboxPage — catalog-driven lane sub-chips (2026-08-24 slice)', () => {
  it('multi-role lane renders one sub-chip per role from role_codes, labeled from the catalog', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Microbiology' }))
    expect(await screen.findByRole('button', { name: /^All/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Endotoxin/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Sterility/ })).toBeInTheDocument()
  })

  it('single-role lane renders NO sub-chip row', async () => {
    renderPage()
    // default lane is Analytical (role_codes: ['hplc'] in this fixture)
    await screen.findByRole('button', { name: 'Analytical' })
    expect(screen.queryByRole('button', { name: /^All/ })).not.toBeInTheDocument()
  })

  it('sub-chip filters by role_tags — rider work (fentanyl on an hplc host vial) is reachable under its own chip', async () => {
    mockGetInboxLanes.mockResolvedValue([
      { key: 'hplc', label: 'Analytical', role_codes: ['hplc', 'fentanyl'], sort_order: 0 },
    ])
    mockGetInboxSamples.mockResolvedValue({
      items: [
        _vial('P-9001', ['hplc'], 'hplc'),
        _vial('P-9002', ['fentanyl', 'hplc'], 'hplc'),   // fent rides this host
      ],
      total: 2,
      filter_role: 'hplc',
    })
    renderPage()
    // Faceted count badges ride the chip's accessible name: 2 vials total,
    // 1 carrying fentanyl work (the worksheet-sidebar count sibling).
    expect(await screen.findByRole('button', { name: 'All 2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fentanyl Screening 1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Fentanyl Screening/ }))
    expect(await screen.findByText('1 vial')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^All/ }))
    expect(await screen.findByText('2 vials')).toBeInTheDocument()
  })

  it('pre-1.8.5 payloads without role_tags degrade to the bare assignment_role', async () => {
    mockGetInboxLanes.mockResolvedValue([
      { key: 'hplc', label: 'Analytical', role_codes: ['hplc', 'fentanyl'], sort_order: 0 },
    ])
    mockGetInboxSamples.mockResolvedValue({
      items: [
        _vial('P-9003', undefined, 'hplc'),
        _vial('P-9004', undefined, 'fentanyl'),
      ],
      total: 2,
      filter_role: 'hplc',
    })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /^Fentanyl Screening/ }))
    expect(await screen.findByText('1 vial')).toBeInTheDocument()
  })

  it('switching lanes clears the active sub-chip selection', async () => {
    mockGetInboxSamples.mockResolvedValue({
      items: [_vial('P-9005', ['endo'], 'endo'), _vial('P-9006', ['ster'], 'ster')],
      total: 2,
      filter_role: 'microbiology',
    })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Microbiology' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Endotoxin/ }))
    expect(await screen.findByText('1 vial')).toBeInTheDocument()
    // leave and return — the filter must not survive the lane switch
    fireEvent.click(screen.getByRole('button', { name: 'Analytical' }))
    fireEvent.click(screen.getByRole('button', { name: 'Microbiology' }))
    expect(await screen.findByText('2 vials')).toBeInTheDocument()
  })
})
