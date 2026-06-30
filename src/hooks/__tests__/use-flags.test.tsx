import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import * as api from '@/lib/flags-api'
import {
  flagKeys,
  useFlagSummary,
  useFlagsList,
  useCreateFlag,
  useAddComment,
  useChangeStatus,
} from '@/hooks/use-flags'

// Mock the REST layer — these tests guard query-key wiring + invalidation, not
// the network. Each fn returns a minimal valid shape.
vi.mock('@/lib/flags-api', async () => {
  const actual = (await vi.importActual('@/lib/flags-api')) as Record<
    string,
    unknown
  >
  return {
    ...actual,
    listFlags: vi.fn(async () => []),
    getSummary: vi.fn(async () => ({ assigned_to_me: 0, by_type: {} })),
    getFlag: vi.fn(async () => ({ comments: [], events: [] })),
    createFlag: vi.fn(async () => ({ id: 1 })),
    addComment: vi.fn(async () => ({ id: 1 })),
    changeStatus: vi.fn(async () => ({ id: 1 })),
  }
})

function makeWrapper(qc: QueryClient) {
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
  Wrapper.displayName = 'TestWrapper'
  return Wrapper
}

describe('flagKeys', () => {
  it('produces stable, scoped query keys', () => {
    expect(flagKeys.summary()).toEqual(['flags', 'summary'])
    expect(flagKeys.list('assigned')).toEqual(['flags', 'list', 'assigned', {}])
    expect(flagKeys.detail(7)).toEqual(['flags', 7])
  })
})

describe('flag queries', () => {
  beforeEach(() => vi.clearAllMocks())

  it('useFlagsList queries the requested tab', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    renderHook(() => useFlagsList('watching'), { wrapper: makeWrapper(qc) })
    await waitFor(() =>
      expect(api.listFlags).toHaveBeenCalledWith('watching', undefined)
    )
    qc.clear()
  })

  it('useFlagSummary reads the summary endpoint', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    renderHook(() => useFlagSummary(), { wrapper: makeWrapper(qc) })
    await waitFor(() => expect(api.getSummary).toHaveBeenCalledTimes(1))
    qc.clear()
  })
})

describe('flag mutations invalidate the right keys', () => {
  beforeEach(() => vi.clearAllMocks())

  it('useCreateFlag refetches the list + summary', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const wrapper = makeWrapper(qc)

    const { result } = renderHook(
      () => ({
        list: useFlagsList('all_open'),
        summary: useFlagSummary(),
        create: useCreateFlag(),
      }),
      { wrapper }
    )

    await waitFor(() => {
      expect(api.listFlags).toHaveBeenCalledTimes(1)
      expect(api.getSummary).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      await result.current.create.mutateAsync({
        entity_type: 'sub_sample',
        entity_id: '1',
        type: 'blocker',
        title: 'x',
      })
    })

    await waitFor(() => {
      expect(api.listFlags).toHaveBeenCalledTimes(2)
      expect(api.getSummary).toHaveBeenCalledTimes(2)
    })
    qc.clear()
  })

  it('useAddComment refetches only the thread, not the lists', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const wrapper = makeWrapper(qc)

    const { result } = renderHook(
      () => ({
        list: useFlagsList('assigned'),
        comment: useAddComment(7),
      }),
      { wrapper }
    )

    await waitFor(() => expect(api.listFlags).toHaveBeenCalledTimes(1))

    await act(async () => {
      await result.current.comment.mutateAsync('hello')
    })

    // Comment touches the thread detail only — the list stays put.
    expect(api.listFlags).toHaveBeenCalledTimes(1)
    expect(api.addComment).toHaveBeenCalledWith(7, 'hello')
    qc.clear()
  })

  it('useChangeStatus refetches the list + summary', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const wrapper = makeWrapper(qc)

    const { result } = renderHook(
      () => ({
        list: useFlagsList('all_open'),
        summary: useFlagSummary(),
        status: useChangeStatus(7),
      }),
      { wrapper }
    )

    await waitFor(() => {
      expect(api.listFlags).toHaveBeenCalledTimes(1)
      expect(api.getSummary).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      await result.current.status.mutateAsync('in_progress')
    })

    await waitFor(() => {
      expect(api.listFlags).toHaveBeenCalledTimes(2)
      expect(api.getSummary).toHaveBeenCalledTimes(2)
    })
    expect(api.changeStatus).toHaveBeenCalledWith(7, 'in_progress')
    qc.clear()
  })
})
