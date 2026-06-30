/**
 * Entity presentation + deep-link routing for flags.
 *
 * The Plan-1 `FlagResponse` carries only `entity_type` + `entity_id` (a pk
 * string), not a resolved human label — so cards render "Vial 42", not
 * "Vial P-1023-3" (a resolved-label field on the API is a future enhancement).
 *
 * Deep-linking maps an entity to the real `ui-store` navigators. Reconciled
 * against `useHashNavigation` (see backend/flags/seams.py):
 *   - sample    → senaite/sample-details         (navigateToSample)
 *   - worksheet → worksheet-detail drawer         (openWorksheetDrawer)
 *   - sub_sample → NO dedicated route; vials are viewed inside the parent
 *     sample page and the event payload lacks the parent id, so the arrow is
 *     suppressed for vials (documented gap, deferred to a follow-up).
 */

import { FlaskConical, TestTube2, ClipboardList, Tag } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useUIStore } from '@/store/ui-store'

interface EntityMeta {
  Icon: LucideIcon
  label: string
  canDeepLink: boolean
}

const ENTITY_META: Record<string, EntityMeta> = {
  sample: { Icon: FlaskConical, label: 'Sample', canDeepLink: true },
  sub_sample: { Icon: TestTube2, label: 'Vial', canDeepLink: false },
  worksheet: { Icon: ClipboardList, label: 'Worksheet', canDeepLink: true },
}

export function entityMeta(entityType: string): EntityMeta {
  return (
    ENTITY_META[entityType] ?? {
      Icon: Tag,
      label: entityType,
      canDeepLink: false,
    }
  )
}

/** Short "Vial 42" style label for the entity chip. */
export function entityLabel(entityType: string, entityId: string): string {
  return `${entityMeta(entityType).label} ${entityId}`
}

/**
 * Navigate to a flagged entity's page and close the flyout. Returns false (and
 * does nothing) for entity types without a first-class route.
 */
export function navigateToEntity(
  entityType: string,
  entityId: string
): boolean {
  const store = useUIStore.getState()
  switch (entityType) {
    case 'sample':
      store.closeFlagsFlyout()
      store.navigateToSample(entityId)
      return true
    case 'worksheet':
      store.closeFlagsFlyout()
      store.openWorksheetDrawer(Number(entityId))
      return true
    default:
      return false
  }
}
