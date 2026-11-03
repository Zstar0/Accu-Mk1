/**
 * The Tasks page's list: the active tab's flags with the page's filters and
 * comment search applied, plus the unread state that drives row markers and
 * tab dots. Activity renders the event feed, so its list is empty.
 */
import { useAuthStore } from '@/store/auth-store'
import { useFlagsList, useFlagUnread, useFlagSearch } from '@/hooks/use-flags'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { unreadBuckets } from '@/components/flags/unread-buckets'
import {
  filterFlags,
  type FlagFilterState,
} from '@/components/flags/flag-filter'
import {
  mergeSearchHits,
  type FlagSearchMeta,
} from '@/components/flags/flag-search'
import type { FlagResponse, FlagTab } from '@/lib/flags-api'
import type { TasksTab } from '@/components/tasks/tasks-tabs'

export interface TaskList {
  total: number
  visibleFlags: FlagResponse[]
  searchMeta: Map<number, FlagSearchMeta>
  isLoading: boolean
  isError: boolean
  refetch: () => void
  searchPending: boolean
  unreadIds: Set<number>
  unreadCount: number
  buckets: ReturnType<typeof unreadBuckets>
}

/** Shared empty map for the non-search branch (avoids a new Map() per render). */
const EMPTY_SEARCH_META = new Map<number, FlagSearchMeta>()

// ponytail: duplicates FlagsFlyout's un-scoped derivation; switch the flyout to this hook in a later change.
export function useTaskList(tab: TasksTab, filter: FlagFilterState): TaskList {
  const me = useAuthStore(state => state.user?.id ?? null)
  const isActivity = tab === 'activity'
  const isUnread = tab === 'unread'

  // Activity/Unread aren't real API tabs: hold a valid FlagTab so the query
  // stays well-formed; its result is ignored on those tabs.
  const tabQuery = useFlagsList(
    isActivity || isUnread ? 'assigned' : (tab as FlagTab)
  )
  // One unread query: the Unread tab's list, row markers and tab dots.
  const unreadQuery = useFlagUnread()
  const unreadFlags = unreadQuery.data ?? []
  const unreadIds = new Set(unreadFlags.map(f => f.id))
  const buckets = unreadBuckets(unreadFlags, me)

  const query = isUnread ? unreadQuery : tabQuery
  const flags = isActivity ? [] : query.data

  // Client-side triage filters layered on the fetched list (no API change).
  const total = flags?.length ?? 0
  const clientVisible = flags ? filterFlags(flags, filter) : []

  // Comment search: for a 3+ char query (debounced) also fetch server matches
  // and merge in the comment-only hits the client filter dropped.
  const liveText = filter.text.trim()
  const debouncedText = useDebouncedValue(liveText, 300)
  const searchActive =
    !isActivity && liveText.length >= 3 && debouncedText.length >= 3
  const searchQuery = useFlagSearch(searchActive ? debouncedText : '')
  const hits = searchQuery.data ?? []

  const { flags: visibleFlags, searchMeta } = searchActive
    ? mergeSearchHits(flags ?? [], clientVisible, hits)
    : { flags: clientVisible, searchMeta: EMPTY_SEARCH_META }

  return {
    total,
    visibleFlags,
    searchMeta,
    isLoading: !isActivity && query.isLoading,
    isError: !isActivity && query.isError,
    refetch: query.refetch,
    // Don't flash "no matches" while a comment query is still in flight.
    searchPending: searchActive && searchQuery.isFetching,
    unreadIds,
    unreadCount: unreadFlags.length,
    buckets,
  }
}
