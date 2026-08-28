import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { listWorksheets } from '@/lib/api'
import { useWorksheetDrawer } from '@/hooks/use-worksheet-drawer'

vi.mock('@/lib/api', () => ({
  listWorksheets: vi.fn(async () => []),
  getWorksheet: vi.fn(async () => null),
  updateWorksheet: vi.fn(),
  removeWorksheetItem: vi.fn(),
  completeWorksheet: vi.fn(),
  reassignWorksheetItem: vi.fn(),
  addGroupToWorksheet: vi.fn(),
  reorderWorksheetItems: vi.fn(),
  updateWorksheetItem: vi.fn(),
  applyWorksheetMethodInstrument: vi.fn(),
}))

// Behavioral contract: the app-scope drawer hook (MainWindow badge) and the
// SampleDetails worksheet-chip query must share ONE cache entry. Under two
// different keys a cold sample-details load fetched /worksheets twice
// (2026-07-07 prod trace). Since 2026-08-27 the shared entry is the OPEN
// filter — the unfiltered fetch served the full worksheet history
// (16.9s/4.2MB on prod) and is reserved for the list page's on-demand tabs.

describe('worksheets list fetch dedup', () => {
  beforeEach(() => {
    vi.mocked(listWorksheets).mockClear()
  })

  it('drawer hook and the sample-details query share one open-filter fetch', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)

    const { result } = renderHook(
      () => {
        const drawer = useWorksheetDrawer()
        // Mirrors SampleDetails.tsx's worksheet-chip query key/fn literally.
        const chip = useQuery({
          queryKey: ['worksheets-list', 'open'],
          queryFn: () => listWorksheets('open'),
          staleTime: 30_000,
        })
        return { drawer, chip }
      },
      { wrapper }
    )

    await waitFor(() => {
      expect(result.current.drawer.isLoading).toBe(false)
      expect(result.current.chip.isLoading).toBe(false)
    })
    expect(listWorksheets).toHaveBeenCalledTimes(1)
    // The shared fetch must be the OPEN filter — an unfiltered call here
    // means a consumer regressed to serving the full worksheet history.
    expect(listWorksheets).toHaveBeenCalledWith('open')

    qc.clear()
  })
})
