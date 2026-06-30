/**
 * TanStack Query layer for the user-managed flag-type catalog (Plan 5).
 *
 * Mirrors `services/sla.ts`. Mutations invalidate the type list AND `['flags']`
 * so every pill/chip recolors when a type's label/color/scope changes. The
 * `useFlagTypesMap()` hook resolves slug → {label,color,kind} for rendering and
 * INCLUDES inactive types (a deactivated type can still own open flags whose
 * pills must keep their color), falling back to the static `FLAG_TYPES` so it is
 * never empty while loading.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  getFlagTypes,
  createFlagType,
  updateFlagType,
  deleteFlagType,
  getFlagEntityTypes,
  type FlagType,
  type FlagTypeCreate,
  type FlagTypeUpdate,
} from '@/lib/flags-api'
import { flagKeys } from '@/hooks/use-flags'
import { FLAG_TYPES, type FlagTypeDef } from '@/components/flags/flag-catalog'

export const flagTypeKeys = {
  all: ['flag-types'] as const,
  list: (params?: { entity_type?: string; active_only?: boolean }) =>
    ['flag-types', 'list', params ?? {}] as const,
  entityTypes: ['flag-types', 'entity-types'] as const,
}

/** The managed type catalog. Omit `active_only` for color/label resolution;
 *  pass `active_only: true` for the raise picker, `entity_type` to scope it. */
export function useFlagTypes(params?: {
  entity_type?: string
  active_only?: boolean
}) {
  return useQuery({
    queryKey: flagTypeKeys.list(params),
    queryFn: () => getFlagTypes(params),
    staleTime: 1000 * 60 * 5,
  })
}

/** Registered entity-type slugs (display names resolved via ENTITY_META). */
export function useFlagEntityTypes() {
  return useQuery({
    queryKey: flagTypeKeys.entityTypes,
    queryFn: getFlagEntityTypes,
    staleTime: 1000 * 60 * 5,
  })
}

/** Invalidate the type catalog AND all flag queries (so pills/chips recolor). */
function invalidateTypesAndFlags(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: flagTypeKeys.all })
  qc.invalidateQueries({ queryKey: flagKeys.all })
}

export function useCreateFlagType() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: FlagTypeCreate) => createFlagType(data),
    onSuccess: () => {
      invalidateTypesAndFlags(qc)
      toast.success('Flag type created')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useUpdateFlagType() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: FlagTypeUpdate }) =>
      updateFlagType(id, data),
    onSuccess: () => invalidateTypesAndFlags(qc),
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteFlagType() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteFlagType(id),
    onSuccess: () => {
      invalidateTypesAndFlags(qc)
      toast.success('Flag type deleted')
    },
    // 409 (built-in/in-use) is handled by the caller (offer deactivate); other
    // errors surface as a toast.
    onError: (e: Error) => toast.error(e.message),
  })
}

/**
 * slug → {label,color,kind} for rendering pills/chips. Built from the FULL type
 * list (inactive included) overlaid on the static `FLAG_TYPES` fallback so it is
 * never empty and a deactivated-but-used type still resolves its color/label.
 */
export function useFlagTypesMap(): Record<string, FlagTypeDef> {
  const { data } = useFlagTypes({})
  const map: Record<string, FlagTypeDef> = { ...FLAG_TYPES }
  for (const t of data ?? []) {
    map[t.slug] = { label: t.label, color: t.color, kind: t.kind }
  }
  return map
}

export type { FlagType }
