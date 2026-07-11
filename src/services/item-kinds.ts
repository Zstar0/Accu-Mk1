/**
 * TanStack Query layer for the user-managed item-kind catalog (slice 7).
 *
 * Mirrors `services/flag-types.ts`. Mutations invalidate the kind list AND
 * `['flags']` so every kind chip/label recolors when a kind changes. The
 * `useItemKindsMap()` hook resolves slug → {label,color} for rendering
 * kind-anchored flags and INCLUDES inactive kinds (a deactivated kind can still
 * own open flags whose chips must keep rendering), seeded with the general_task
 * builtin so it is never empty while loading.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  getItemKinds,
  createItemKind,
  updateItemKind,
  deleteItemKind,
  FlagTypeApiError,
  type FlagItemKind,
  type FlagItemKindCreate,
  type FlagItemKindUpdate,
} from '@/lib/flags-api'
import { flagKeys } from '@/hooks/use-flags'

export const itemKindKeys = {
  all: ['item-kinds'] as const,
  list: (params?: { active_only?: boolean }) =>
    ['item-kinds', 'list', params ?? {}] as const,
}

/** The seeded builtin, used as a never-empty fallback while the query loads. */
export const BUILTIN_ITEM_KINDS: FlagItemKind[] = [
  {
    id: -1,
    slug: 'general_task',
    label: 'General Task',
    color: '#6b7280',
    is_active: true,
    is_builtin: true,
    sort_order: 0,
  },
]

/** The managed item-kind catalog. Omit `active_only` for label resolution;
 *  pass `active_only: true` for the compose/filter picker. */
export function useItemKinds(params?: { active_only?: boolean }) {
  return useQuery({
    queryKey: itemKindKeys.list(params),
    queryFn: () => getItemKinds(params),
    staleTime: 1000 * 60 * 5,
  })
}

/** Invalidate the kind catalog AND all flag queries (so kind chips recolor). */
function invalidateKindsAndFlags(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: itemKindKeys.all })
  qc.invalidateQueries({ queryKey: flagKeys.all })
}

export function useCreateItemKind() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: FlagItemKindCreate) => createItemKind(data),
    onSuccess: () => {
      invalidateKindsAndFlags(qc)
      toast.success('Item kind created')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useUpdateItemKind() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: FlagItemKindUpdate }) =>
      updateItemKind(id, data),
    onSuccess: () => invalidateKindsAndFlags(qc),
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteItemKind() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteItemKind(id),
    onSuccess: () => {
      invalidateKindsAndFlags(qc)
      toast.success('Item kind deleted')
    },
    // 409 (built-in/in-use) is handled inline by the caller (offer deactivate);
    // only surface a toast for other errors.
    onError: (e: Error) => {
      if (e instanceof FlagTypeApiError && e.status === 409) return
      toast.error(e.message)
    },
  })
}

/** slug → {label,color} for rendering kind-anchored flags. Built from the FULL
 *  kind list (inactive included) so a deactivated-but-used kind still resolves,
 *  seeded with the general_task builtin so it is never empty while loading. */
export function useItemKindsMap(): Record<string, { label: string; color: string }> {
  const { data } = useItemKinds()
  const map: Record<string, { label: string; color: string }> = {}
  for (const k of [...BUILTIN_ITEM_KINDS, ...(data ?? [])]) {
    map[k.slug] = { label: k.label, color: k.color }
  }
  return map
}

/** slug → label projection of {@link useItemKindsMap}, for entityDisplayLabel. */
export function useItemKindLabels(): Record<string, string> {
  const { data } = useItemKinds()
  const map: Record<string, string> = {}
  for (const k of [...BUILTIN_ITEM_KINDS, ...(data ?? [])]) map[k.slug] = k.label
  return map
}

export type { FlagItemKind }
