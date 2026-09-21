import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import {
  listWorksheets,
  updateWorksheetItem,
  type WorksheetListItem,
} from '@/lib/api'
import { useWorksheetDrawer } from '@/hooks/use-worksheet-drawer'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/api', () => ({
  listWorksheets: vi.fn(),
  getWorksheet: vi.fn(async () => null),
  updateWorksheet: vi.fn(),
  removeWorksheetItem: vi.fn(),
  completeWorksheet: vi.fn(),
  reassignWorksheetItem: vi.fn(),
  addGroupToWorksheet: vi.fn(),
  reorderWorksheetItems: vi.fn(),
  updateWorksheetItem: vi.fn(),
  bulkWorksheetBenchTicks: vi.fn(),
  applyWorksheetMethodInstrument: vi.fn(),
}))

// A bench sheet is keyed in after the run, so ticks arrive in bursts: several
// PATCHes are in flight at once against one shared list cache. Each one used
// to refetch the list the moment it landed (wiping the checkmarks of the ticks
// still in flight) and, on failure, to restore a whole-list snapshot taken
// before its neighbours existed (reverting rows that had succeeded).

type Item = WorksheetListItem['items'][number]

function worksheet(items: Partial<Item>[]): WorksheetListItem {
  return {
    id: 24,
    title: 'Endo 09/18/2026',
    status: 'open',
    items: items.map(it => ({ prep_status: 'ready', ...it })),
  } as unknown as WorksheetListItem
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
  const hook = renderHook(() => useWorksheetDrawer(), { wrapper })
  const madeAt = (itemId: number) =>
    qc
      .getQueryData<WorksheetListItem[]>(['worksheets-list', 'open'])?.[0]
      ?.items.find(it => it.id === itemId)?.made_at ?? null
  return { qc, hook, madeAt }
}

describe('bench ticks arriving in a burst', () => {
  beforeEach(() => {
    vi.mocked(listWorksheets).mockReset()
    vi.mocked(updateWorksheetItem).mockReset()
  })

  it('does not refetch the list while another tick is still in flight', async () => {
    // Whatever the server says mid-burst, row 2 is not committed there yet.
    vi.mocked(listWorksheets).mockResolvedValue([
      worksheet([{ id: 1 }, { id: 2 }]),
    ])
    const first = deferred<{ status: string; item_id: number }>()
    const second = deferred<{ status: string; item_id: number }>()
    vi.mocked(updateWorksheetItem)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const { hook, madeAt, qc } = setup()
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false))
    expect(listWorksheets).toHaveBeenCalledTimes(1)

    act(() => {
      const m = hook.result.current.updateItemMutation
      m.mutate({ worksheetId: 24, itemId: 1, data: { made: true } })
      m.mutate({ worksheetId: 24, itemId: 2, data: { made: true } })
    })
    await waitFor(() => expect(madeAt(2)).not.toBeNull())

    await act(async () => {
      first.resolve({ status: 'updated', item_id: 1 })
      await first.promise
    })
    // The first tick landing must leave the second one's checkmark alone.
    expect(listWorksheets).toHaveBeenCalledTimes(1)
    expect(madeAt(2)).not.toBeNull()

    await act(async () => {
      second.resolve({ status: 'updated', item_id: 2 })
      await second.promise
    })
    // The burst is over: now the server's word is fetched, once.
    await waitFor(() => expect(listWorksheets).toHaveBeenCalledTimes(2))
    qc.clear()
  })

  it('a failed tick reverts its own row, never a neighbour', async () => {
    vi.mocked(listWorksheets).mockResolvedValue([
      worksheet([{ id: 1 }, { id: 2 }]),
    ])
    const first = deferred<{ status: string; item_id: number }>()
    const second = deferred<{ status: string; item_id: number }>()
    vi.mocked(updateWorksheetItem)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const { hook, madeAt, qc } = setup()
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false))

    act(() => {
      const m = hook.result.current.updateItemMutation
      m.mutate({ worksheetId: 24, itemId: 1, data: { made: true } })
      m.mutate({ worksheetId: 24, itemId: 2, data: { made: true } })
    })
    await waitFor(() => expect(madeAt(2)).not.toBeNull())

    await act(async () => {
      first.reject(new Error('Update item failed: 500'))
      await first.promise.catch(() => undefined)
    })
    await waitFor(() => expect(madeAt(1)).toBeNull())
    expect(madeAt(2)).not.toBeNull()
    qc.clear()
  })
})
