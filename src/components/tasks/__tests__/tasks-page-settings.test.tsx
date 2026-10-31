import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { useAuthStore, type AuthUser } from '@/store/auth-store'
import {
  DEFAULT_TASKS_SETTINGS,
  parseTasksSettings,
  useTasksPageSettings,
} from '@/components/tasks/tasks-page-settings'

const get = vi.fn()
const put = vi.fn()
vi.mock('@/lib/ui-settings-api', () => ({
  getUiSetting: (...args: unknown[]) => get(...args),
  putUiSetting: (...args: unknown[]) => put(...args),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

async function mountReady(client = newClient()) {
  const hook = renderHook(() => useTasksPageSettings(), {
    wrapper: wrapperFor(client),
  })
  await waitFor(() => expect(hook.result.current.ready).toBe(true))
  return hook
}

beforeEach(() => {
  get.mockReset()
  put.mockReset()
  vi.mocked(toast.error).mockReset()
  get.mockResolvedValue(null)
  put.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  useAuthStore.setState({ user: null })
})

describe('parseTasksSettings', () => {
  it('parseTasksSettings sanitizes bad input', () => {
    expect(parseTasksSettings(null)).toEqual(DEFAULT_TASKS_SETTINGS)
    expect(parseTasksSettings([1])).toEqual(DEFAULT_TASKS_SETTINGS)
    const p = parseTasksSettings({
      v: 1,
      tab: 'gone',
      sorting: [{ id: 'nope', desc: true }],
      columnSizing: {
        title: 99999,
        type: 10,
        item: 0,
        due: -5,
        status: Number.NaN,
        ghost: 200,
      },
    })
    expect(p.tab).toBe('assigned')
    expect(p.sorting).toEqual([])
    // positive values clamped; <= 0, NaN and unknown ids dropped
    expect(p.columnSizing).toEqual({ title: 900, type: 80 })
  })

  it('keeps only the first sort entry', () => {
    expect(
      parseTasksSettings({
        sorting: [
          { id: 'due', desc: false },
          { id: 'title', desc: true },
        ],
      }).sorting
    ).toEqual([{ id: 'due', desc: false }])
  })
})

describe('useTasksPageSettings', () => {
  it('loads a saved value once and applies it', async () => {
    get.mockResolvedValue({ tab: 'watching' })
    const { result } = await mountReady()
    expect(result.current.settings.tab).toBe('watching')
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('tasks.page')
  })

  it('a transient load failure retries before using defaults', async () => {
    get
      .mockRejectedValueOnce(
        new Error('GET /api/ui-settings/tasks.page failed: 503')
      )
      .mockResolvedValue({ tab: 'watching' })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: 1, retryDelay: 0 } },
    })
    const { result } = await mountReady(client)
    expect(get).toHaveBeenCalledTimes(2)
    expect(result.current.settings.tab).toBe('watching')
  })

  // newClient() turns retries off, so one rejection is the final failure.
  it('load failure falls back to defaults without saving', async () => {
    get.mockRejectedValue(
      new Error('GET /api/ui-settings/tasks.page failed: 500')
    )
    const { result, unmount } = await mountReady()
    expect(result.current.settings).toEqual(DEFAULT_TASKS_SETTINGS)
    unmount()
    expect(put).not.toHaveBeenCalled()
  })

  it('debounces saves into one PUT of the merged value', async () => {
    const { result } = await mountReady()
    vi.useFakeTimers()
    act(() => result.current.update({ tab: 'raised' }))
    act(() => result.current.update({ sorting: [{ id: 'due', desc: true }] }))
    act(() => {
      vi.advanceTimersByTime(499)
    })
    expect(put).toHaveBeenCalledTimes(0)
    // The cache already holds the merged value, before any save.
    expect(result.current.settings.tab).toBe('raised')
    expect(result.current.settings.sorting).toEqual([{ id: 'due', desc: true }])
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(put).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledWith(
      'tasks.page',
      expect.objectContaining({
        v: 1,
        tab: 'raised',
        sorting: [{ id: 'due', desc: true }],
      })
    )
  })

  it('a save keeps keys and column ids this build does not know', async () => {
    get.mockResolvedValue({
      v: 2,
      tab: 'watching',
      density: 'compact',
      columnSizing: { title: 300, priority: 120 },
    })
    const { result, unmount } = await mountReady()
    act(() => result.current.update({ tab: 'raised' }))
    act(() => result.current.update({ columnSizing: { title: 400 } }))
    unmount()
    expect(put).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledWith('tasks.page', {
      v: 2,
      tab: 'raised',
      density: 'compact',
      sorting: [],
      columnSizing: { title: 400, priority: 120 },
    })
  })

  it('a pending save flushes on unmount', async () => {
    const { result, unmount } = await mountReady()
    act(() => result.current.update({ tab: 'raised' }))
    expect(put).not.toHaveBeenCalled()
    unmount()
    expect(put).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledWith(
      'tasks.page',
      expect.objectContaining({ tab: 'raised' })
    )
  })

  it('a failed save logs the error and shows one toast', async () => {
    const failure = new Error('PUT /api/ui-settings/tasks.page failed: 500')
    put.mockRejectedValue(failure)
    const logError = vi
      .spyOn(logger, 'error')
      .mockImplementation(() => undefined)
    const { result } = await mountReady()
    vi.useFakeTimers()
    act(() => result.current.update({ tab: 'raised' }))
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(toast.error).toHaveBeenCalledTimes(1)
    // A fixed id: repeated failures replace the toast instead of stacking.
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't save your table settings",
      { id: 'tasks-settings-save' }
    )
    expect(logError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: failure })
    )
    // The user's layout stays on screen.
    expect(result.current.settings.tab).toBe('raised')
  })

  it('a remount shows the updated value without a second GET', async () => {
    const client = newClient()
    const first = await mountReady(client)
    act(() => first.result.current.update({ tab: 'raised' }))
    first.unmount()
    const { result } = renderHook(() => useTasksPageSettings(), {
      wrapper: wrapperFor(client),
    })
    expect(result.current.ready).toBe(true)
    expect(result.current.settings.tab).toBe('raised')
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('a different user in the same window gets their own settings', async () => {
    const client = newClient()
    useAuthStore.setState({ user: { id: 1 } as AuthUser })
    const first = await mountReady(client)
    act(() => first.result.current.update({ tab: 'raised' }))
    first.unmount()
    expect(put).toHaveBeenCalledTimes(1)

    useAuthStore.setState({ user: { id: 2 } as AuthUser })
    const second = await mountReady(client)
    expect(get).toHaveBeenCalledTimes(2)
    expect(second.result.current.settings.tab).toBe('assigned')

    // User 2's first change saves user 2's layout, not user 1's merged in.
    act(() =>
      second.result.current.update({ sorting: [{ id: 'due', desc: true }] })
    )
    second.unmount()
    expect(put).toHaveBeenLastCalledWith(
      'tasks.page',
      expect.objectContaining({ tab: 'assigned' })
    )
  })
})
