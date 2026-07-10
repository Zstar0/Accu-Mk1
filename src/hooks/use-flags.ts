/**
 * TanStack Query hooks for the Flag System.
 *
 * Server data only (the state-onion's outer ring). UI open/thread state lives
 * in `ui-store`; live deltas arrive via `flag-stream`. Query keys are stable so
 * the SSE glue can blanket-invalidate `['flags']` on any event.
 */

import {
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import {
  listFlags,
  listEntityFlags,
  getFlag,
  getSummary,
  getActivity,
  getUnread,
  createFlag,
  addComment,
  assignFlag,
  changeStatus,
  addWatcher,
  removeWatcher,
  addReaction,
  removeReaction,
  type FlagTab,
  type ListFlagsParams,
  type FlagStatus,
  type CreateFlagBody,
  type ActivityPage,
} from '@/lib/flags-api'

// --- query keys (exported so tests + the SSE glue share the literals) ---

export const flagKeys = {
  all: ['flags'] as const,
  summary: () => ['flags', 'summary'] as const,
  lists: () => ['flags', 'list'] as const,
  list: (tab: FlagTab, params?: ListFlagsParams) =>
    ['flags', 'list', tab, params ?? {}] as const,
  // Entity-scoped open flags. Under ['flags', …] so the SSE glue's blanket
  // invalidate(['flags']) refreshes every EntityFlagButton on any flag event.
  entity: (entityType: string, entityId: string, includeDescendants: boolean) =>
    ['flags', 'entity', entityType, entityId, includeDescendants] as const,
  activity: () => ['flags', 'activity'] as const,
  unread: () => ['flags', 'unread'] as const,
  detail: (id: number) => ['flags', id] as const,
}

// --- queries ---

/** Header-button counts. Cheap; refetched on every flag event. */
export function useFlagSummary() {
  return useQuery({
    queryKey: flagKeys.summary(),
    queryFn: getSummary,
    staleTime: 10_000,
  })
}

/** One triage tab's flag list. */
export function useFlagsList(tab: FlagTab, params?: ListFlagsParams) {
  return useQuery({
    queryKey: flagKeys.list(tab, params),
    queryFn: () => listFlags(tab, params),
    staleTime: 5_000,
  })
}

/** Open flags on one entity (optionally rolling up its descendants). Drives the
 *  stateful EntityFlagButton; disabled until both ids are present. */
export function useEntityFlags(
  entityType: string | null | undefined,
  entityId: string | null | undefined,
  opts?: { includeDescendants?: boolean }
) {
  const includeDescendants = opts?.includeDescendants ?? false
  return useQuery({
    queryKey: flagKeys.entity(
      entityType ?? '',
      entityId ?? '',
      includeDescendants
    ),
    queryFn: () =>
      listEntityFlags(
        entityType as string,
        entityId as string,
        includeDescendants
      ),
    enabled: !!entityType && !!entityId,
    staleTime: 5_000,
  })
}

/** One flag's full thread (comments + events). */
export function useFlag(id: number | null) {
  return useQuery({
    queryKey: flagKeys.detail(id ?? -1),
    queryFn: () => getFlag(id as number),
    enabled: id != null,
  })
}

/** Flags with unread notifications for me. Under ['flags', …] so the glue's
 *  blanket invalidate refreshes it live. */
export function useFlagUnread() {
  return useQuery({
    queryKey: flagKeys.unread(),
    queryFn: getUnread,
    staleTime: 5_000,
  })
}

/** The relevance activity feed — newest-first, keyset-paginated. Under
 *  ['flags', …] so the SSE glue's blanket invalidate refreshes it too. */
export function useFlagActivity() {
  return useInfiniteQuery({
    queryKey: flagKeys.activity(),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      getActivity(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ActivityPage) => last.next_cursor ?? undefined,
    staleTime: 5_000,
  })
}

// --- invalidation helpers ---

/** Lists + summary change together whenever a flag's triage-relevant fields
 *  (status, assignee, existence) change. */
function invalidateListsAndSummary(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: flagKeys.lists() })
  qc.invalidateQueries({ queryKey: flagKeys.summary() })
}

// --- mutations ---

/** Raise a new flag → refresh every list + the summary badge. */
export function useCreateFlag() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateFlagBody) => createFlag(body),
    onSuccess: () => invalidateListsAndSummary(qc),
  })
}

/** Append a comment (with optional @mentions) → only the open thread changes. */
export function useAddComment(flagId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      body,
      mentionIds,
    }: {
      body: string
      mentionIds?: number[]
    }) => addComment(flagId, body, mentionIds),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: flagKeys.detail(flagId) }),
  })
}

/** Assign / unassign → thread + lists + summary. */
export function useAssignFlag(flagId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (assigneeId: number | null) => assignFlag(flagId, assigneeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: flagKeys.detail(flagId) })
      invalidateListsAndSummary(qc)
    },
  })
}

/** Change status → thread + lists + summary. */
export function useChangeStatus(flagId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (toStatus: FlagStatus) => changeStatus(flagId, toStatus),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: flagKeys.detail(flagId) })
      invalidateListsAndSummary(qc)
    },
  })
}

/** Watch a flag → thread (watcher count) + the Watching list. */
export function useAddWatcher(flagId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: number) => addWatcher(flagId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: flagKeys.detail(flagId) })
      qc.invalidateQueries({ queryKey: flagKeys.lists() })
    },
  })
}

/** Unwatch a flag → thread (watcher count) + the Watching list. */
export function useRemoveWatcher(flagId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: number) => removeWatcher(flagId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: flagKeys.detail(flagId) })
      qc.invalidateQueries({ queryKey: flagKeys.lists() })
    },
  })
}

/** Toggle a reaction on a comment → refresh the open thread. */
export function useAddReaction(flagId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ commentId, emoji }: { commentId: number; emoji: string }) =>
      addReaction(commentId, emoji),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: flagKeys.detail(flagId) }),
  })
}

export function useRemoveReaction(flagId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ commentId, emoji }: { commentId: number; emoji: string }) =>
      removeReaction(commentId, emoji),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: flagKeys.detail(flagId) }),
  })
}
