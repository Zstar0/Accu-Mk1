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
  fetchSampleAggregates,
  listWorksheets,
  type InboxLaneRow,
  type InboxResponse,
} from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getInboxSamples: vi.fn(),
    getInboxLanes: vi.fn(),
    getWorksheetUsers: vi.fn(),
    fetchSampleAggregates: vi.fn(),
    listWorksheets: vi.fn(),
  }
})

import WorksheetsInboxPage from '@/components/hplc/WorksheetsInboxPage'

const mockGetInboxSamples = vi.mocked(getInboxSamples)
const mockGetInboxLanes = vi.mocked(getInboxLanes)
const mockGetWorksheetUsers = vi.mocked(getWorksheetUsers)
const mockFetchSampleAggregates = vi.mocked(fetchSampleAggregates)
const mockListWorksheets = vi.mocked(listWorksheets)

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
  mockFetchSampleAggregates.mockResolvedValue({ aggregates: {} })
  mockListWorksheets.mockResolvedValue([])
})

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
