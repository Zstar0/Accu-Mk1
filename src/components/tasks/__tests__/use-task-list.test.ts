import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlagResponse, FlagSearchHit } from '@/lib/flags-api'
import { EMPTY_FLAG_FILTER } from '@/components/flags/flag-filter'
import { useTaskList } from '@/components/tasks/use-task-list'

const useFlagsList = vi.fn()
const useFlagUnread = vi.fn()
const useFlagSearch = vi.fn()
vi.mock('@/hooks/use-flags', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    useFlagsList: (...args: unknown[]) => useFlagsList(...args),
    useFlagUnread: () => useFlagUnread(),
    useFlagSearch: (...args: unknown[]) => useFlagSearch(...args),
  }
})

function flag(id: number, title: string, status = 'open'): FlagResponse {
  return {
    id,
    entity_type: 'sub_sample',
    entity_id: String(id),
    kind: 'issue',
    type: 'blocker',
    status,
    title,
    created_by: 1,
    assignee_id: 1,
    created_at: '2026-06-30T12:00:00',
    updated_at: '2026-06-30T12:00:00',
    resolved_at: null,
    resolved_by: null,
    due_at: null,
  }
}

const query = (data: unknown) => ({
  data,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
})

const ids = (flags: FlagResponse[]) => flags.map(f => f.id)

beforeEach(() => {
  useFlagsList.mockReset()
  useFlagUnread.mockReset()
  useFlagSearch.mockReset()
  useFlagsList.mockReturnValue(
    query([
      flag(1, 'Photo missing'),
      flag(2, 'Crashed out', 'resolved'),
      flag(3, 'Needs re-prep'),
    ])
  )
  useFlagUnread.mockReturnValue(query([flag(9, 'Unread one')]))
  useFlagSearch.mockReturnValue(query([]))
})

describe('useTaskList', () => {
  it("returns the tab query's flags filtered by status", () => {
    const { result } = renderHook(() =>
      useTaskList('raised', { ...EMPTY_FLAG_FILTER, status: 'all_open' })
    )
    expect(useFlagsList).toHaveBeenCalledWith('raised')
    expect(result.current.total).toBe(3)
    expect(ids(result.current.visibleFlags)).toEqual([1, 3])
    expect(result.current.unreadCount).toBe(1)
    expect(result.current.unreadIds.has(9)).toBe(true)
  })

  it('unread tab returns the unread list', () => {
    const { result } = renderHook(() =>
      useTaskList('unread', EMPTY_FLAG_FILTER)
    )
    // Unread is FE-only: the tab query holds a valid FlagTab.
    expect(useFlagsList).toHaveBeenCalledWith('assigned')
    expect(ids(result.current.visibleFlags)).toEqual([9])
    expect(result.current.total).toBe(1)
  })

  it('a 3+ char search merges a comment-only hit', async () => {
    const hits: FlagSearchHit[] = [
      {
        flag_id: 3,
        snippet: 'swap the pipette tip',
        matched_in: ['comment'],
        title: 'Needs re-prep',
        status: 'open',
        type: 'blocker',
      },
    ]
    useFlagSearch.mockImplementation((q: string) =>
      query(q === 'pipette' ? hits : [])
    )
    const { result } = renderHook(() =>
      useTaskList('assigned', { ...EMPTY_FLAG_FILTER, text: 'pipette' })
    )
    await waitFor(() => expect(ids(result.current.visibleFlags)).toEqual([3]))
    expect(useFlagSearch).toHaveBeenCalledWith('pipette')
    expect(result.current.searchMeta.get(3)?.snippet).toBe(
      'swap the pipette tip'
    )
  })

  it('activity returns an empty list', () => {
    const { result } = renderHook(() =>
      useTaskList('activity', EMPTY_FLAG_FILTER)
    )
    expect(useFlagsList).toHaveBeenCalledWith('assigned')
    expect(result.current.visibleFlags).toEqual([])
    expect(result.current.total).toBe(0)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.unreadCount).toBe(1)
  })
})
