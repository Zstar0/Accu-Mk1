import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import {
  listWorksheets,
  updateWorksheetItem,
  type WorksheetItemPatch,
  type WorksheetListItem,
} from '@/lib/api'
import {
  mergeItemPatch,
  useWorksheetDrawer,
  worksheetPageKey,
} from '@/hooks/use-worksheet-drawer'

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

// The endo worksheet page reads GET /worksheets/{id} from its own cache entry
// (the only read that carries endo_method). A cell typed there must show at
// once and, if the server refuses it, go back, exactly as in the flyout list.

type Item = WorksheetListItem['items'][number]

function worksheet(items: Partial<Item>[]): WorksheetListItem {
  return {
    id: 24,
    title: 'Endo 10/10/2026',
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

describe('mergeItemPatch', () => {
  it('applies the 2 mL fields and leaves the rest alone', () => {
    const [before] = worksheet([{ id: 1 }]).items
    if (!before) throw new Error('fixture')
    const after = mergeItemPatch(before, {
      prep_form: 'liquid',
      prep_water_ml: 1.5,
      prep_total_dilution: 500,
      prep_steps: [[25, 8], null, null],
      cartridge_type_id: 3,
      result_reading: '<0.05',
    })
    expect(after).toMatchObject({
      id: 1,
      prep_status: 'ready',
      prep_form: 'liquid',
      prep_water_ml: 1.5,
      prep_total_dilution: 500,
      prep_steps: [[25, 8], null, null],
      cartridge_type_id: 3,
      result_reading: '<0.05',
    })
  })

  it('an explicit null clears a field', () => {
    const [before] = worksheet([{ id: 1, result_reading: '0.8' }]).items
    if (!before) throw new Error('fixture')
    expect(
      mergeItemPatch(before, { result_reading: null }).result_reading
    ).toBeNull()
  })
})

describe('the worksheet page cache', () => {
  beforeEach(() => {
    vi.mocked(listWorksheets)
      .mockReset()
      .mockResolvedValue([worksheet([{ id: 1 }])])
    vi.mocked(updateWorksheetItem).mockReset()
  })

  it('shows an edit at once and rolls it back on failure, in the list and on the page', async () => {
    const pending = deferred<{ status: string; item_id: number }>()
    vi.mocked(updateWorksheetItem).mockReturnValueOnce(pending.promise)
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    qc.setQueryData(worksheetPageKey(24), worksheet([{ id: 1 }]))
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)
    const hook = renderHook(() => useWorksheetDrawer(), { wrapper })
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false))
    const water = () => ({
      list:
        qc.getQueryData<WorksheetListItem[]>(['worksheets-list', 'open'])?.[0]
          ?.items[0]?.prep_water_ml ?? null,
      page:
        qc.getQueryData<WorksheetListItem>(worksheetPageKey(24))?.items[0]
          ?.prep_water_ml ?? null,
    })

    act(() => {
      hook.result.current.updateItemMutation.mutate({
        worksheetId: 24,
        itemId: 1,
        data: { prep_water_ml: 1.5 },
      })
    })
    await waitFor(() => expect(water()).toEqual({ list: 1.5, page: 1.5 }))

    await act(async () => {
      pending.reject(new Error('Update item failed: 409'))
      await pending.promise.catch(() => undefined)
    })
    await waitFor(() => expect(water()).toEqual({ list: null, page: null }))
    qc.clear()
  })
})

// Fix round 1: a failure rolls each cache entry back from its OWN snapshot,
// and only the keys the failed PATCH wrote, so a neighbouring edit on the
// same row (water, dilution and reading overlap on the 2 mL page) survives.
describe('rolling back a refused edit', () => {
  function setup(listItems: Partial<Item>[], pageItems: Partial<Item>[]) {
    vi.mocked(listWorksheets)
      .mockReset()
      .mockResolvedValue([worksheet(listItems)])
    vi.mocked(updateWorksheetItem).mockReset()
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    qc.setQueryData(worksheetPageKey(24), worksheet(pageItems))
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)
    const hook = renderHook(() => useWorksheetDrawer(), { wrapper })
    const row = (where: 'list' | 'page', itemId = 1) =>
      (where === 'list'
        ? qc.getQueryData<WorksheetListItem[]>(['worksheets-list', 'open'])?.[0]
        : qc.getQueryData<WorksheetListItem>(worksheetPageKey(24))
      )?.items.find(it => it.id === itemId)
    const mutate = (data: WorksheetItemPatch) =>
      act(() => {
        hook.result.current.updateItemMutation.mutate({
          worksheetId: 24,
          itemId: 1,
          data,
        })
      })
    return { qc, hook, row, mutate }
  }

  it('restores the page row from the page, not from the list', async () => {
    const pending = deferred<{ status: string; item_id: number }>()
    const { qc, hook, row, mutate } = setup(
      [{ id: 1 }],
      [{ id: 1, result_reading: '0.8' }]
    )
    vi.mocked(updateWorksheetItem).mockReturnValueOnce(pending.promise)
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false))

    mutate({ result_reading: '0.9' })
    await waitFor(() => expect(row('page')?.result_reading).toBe('0.9'))

    await act(async () => {
      pending.reject(new Error('Update item failed: 409'))
      await pending.promise.catch(() => undefined)
    })
    await waitFor(() => expect(row('page')?.result_reading).toBe('0.8'))
    expect(row('list')?.result_reading ?? null).toBeNull()
    qc.clear()
  })

  it('rolls the page back when the list has the worksheet but not the row', async () => {
    const pending = deferred<{ status: string; item_id: number }>()
    const { qc, hook, row, mutate } = setup([{ id: 2 }], [{ id: 1 }])
    vi.mocked(updateWorksheetItem).mockReturnValueOnce(pending.promise)
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false))

    mutate({ prep_water_ml: 1.5 })
    await waitFor(() => expect(row('page')?.prep_water_ml).toBe(1.5))

    await act(async () => {
      pending.reject(new Error('Update item failed: 409'))
      await pending.promise.catch(() => undefined)
    })
    await waitFor(() => expect(row('page')?.prep_water_ml ?? null).toBeNull())
    qc.clear()
  })

  it('a refused edit leaves another in-flight edit on the same row alone', async () => {
    const water = deferred<{ status: string; item_id: number }>()
    const reading = deferred<{ status: string; item_id: number }>()
    const { qc, hook, row, mutate } = setup([{ id: 1 }], [{ id: 1 }])
    vi.mocked(updateWorksheetItem)
      .mockReturnValueOnce(water.promise)
      .mockReturnValueOnce(reading.promise)
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false))

    mutate({ prep_water_ml: 1.5 })
    mutate({ result_reading: '<0.05' })
    await waitFor(() => expect(row('page')?.result_reading).toBe('<0.05'))
    await waitFor(() => expect(row('list')?.result_reading).toBe('<0.05'))

    await act(async () => {
      water.reject(new Error('Update item failed: 409'))
      await water.promise.catch(() => undefined)
    })
    await waitFor(() => expect(row('page')?.prep_water_ml ?? null).toBeNull())
    expect(row('list')?.prep_water_ml ?? null).toBeNull()
    expect(row('page')?.result_reading).toBe('<0.05')
    expect(row('list')?.result_reading).toBe('<0.05')

    await act(async () => {
      reading.resolve({ status: 'updated', item_id: 1 })
      await reading.promise
    })
    qc.clear()
  })
})
