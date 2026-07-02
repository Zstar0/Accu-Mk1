import { useEffect } from 'react'
import { useUIStore } from '@/store/ui-store'
import { entityLabel } from '@/components/flags/flag-entity'

/**
 * Registers the mounted detail surface's entity as "the page you're on" for
 * flag creation (spec 2026-07-01 multi-flag creation affordances). Pushes on
 * mount / pops on unmount so overlays compose — a worksheet drawer over a
 * sample page stacks, and closing it restores the sample context beneath.
 * No-op while `type`/`id` are missing (e.g. SampleDetails before data
 * resolves); registers when they appear.
 */
export function useRegisterActiveFlagEntity(
  type: string | null | undefined,
  id: string | null | undefined,
  label?: string | null
) {
  useEffect(() => {
    if (!type || !id) return
    const entry = { type, id, label: label || entityLabel(type, id) }
    useUIStore.getState().pushActiveFlagEntity(entry)
    return () => useUIStore.getState().popActiveFlagEntity(entry)
  }, [type, id, label])
}
