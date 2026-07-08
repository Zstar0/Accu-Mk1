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
  updateWorksheet: vi.fn(),
  removeWorksheetItem: vi.fn(),
  completeWorksheet: vi.fn(),
  reassignWorksheetItem: vi.fn(),
  addGroupToWorksheet: vi.fn(),
  reorderWorksheetItems: vi.fn(),
  updateWorksheetItem: vi.fn(),
}))

// Behavioral contract: the app-scope drawer hook (MainWindow badge) and the
// SampleDetails worksheet-chip query must share ONE cache entry. /worksheets
// is ~2.5s of server DB work returning 1.3MB — under two different keys a
// cold sample-details load fetched it twice (2026-07-07 prod trace).

describe('worksheets list fetch dedup', () => {
  beforeEach(() => {
    vi.mocked(listWorksheets).mockClear()
  })

  it('drawer hook and the sample-details query share one fetch', async () => {
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
          queryKey: ['worksheets-list', undefined],
          queryFn: () => listWorksheets(),
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

    qc.clear()
  })
})
