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

import {
  FlaskConical,
  TestTube2,
  ClipboardList,
  Tag,
  ListTodo,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useUIStore } from '@/store/ui-store'
import type { DeepLink, EntityContext, FlagResponse } from '@/lib/flags-api'

interface EntityMeta {
  Icon: LucideIcon
  label: string
  canDeepLink: boolean
}

const ENTITY_META: Record<string, EntityMeta> = {
  sample: { Icon: FlaskConical, label: 'Sample', canDeepLink: true },
  sub_sample: { Icon: TestTube2, label: 'Sub Sample', canDeepLink: false },
  worksheet: { Icon: ClipboardList, label: 'Worksheet', canDeepLink: true },
  // The seeded builtin item kind (slice 7). Legacy null-anchor general tasks are
  // backfilled to this slug; the chip must show a human label, never the slug.
  // Other (admin-created) kinds resolve their label FE-side via useItemKinds.
  general_task: { Icon: ListTodo, label: 'General Task', canDeepLink: false },
}

/** Entity types with a backend `state` seam (→ watchable). Mirror of the
 *  `state=` registrations in backend/flags/seams.py `register_mk1_entities`.
 *  Update both together if another type opts in. */
export const WATCHABLE_ENTITY_TYPES: ReadonlySet<string> = new Set(['sample'])

/** Meta for a null-anchor general task (Phase 2). */
const GENERAL_META: EntityMeta = {
  Icon: ListTodo,
  label: 'General',
  canDeepLink: false,
}

export function entityMeta(entityType: string | null | undefined): EntityMeta {
  if (entityType == null) return GENERAL_META
  return (
    ENTITY_META[entityType] ?? {
      Icon: Tag,
      label: entityType,
      canDeepLink: false,
    }
  )
}

/** Short "Vial 42" style label for the entity chip; "General task" for a null
 *  anchor. Non-null behavior is unchanged. */
export function entityLabel(
  entityType: string | null | undefined,
  entityId: string | null | undefined
): string {
  if (entityType == null) return 'General task'
  // A virtual item kind carries no entity_id — render just the kind label
  // (avoids the "general_task null" the backfill would otherwise produce).
  if (entityId == null) return entityMeta(entityType).label
  return `${entityMeta(entityType).label} ${entityId}`
}

/**
 * Navigate to a flagged entity's page and close the flyout. Returns false (and
 * does nothing) for entity types without a first-class route.
 *
 * Legacy fallback used only when the server `entity` context (and its resolved
 * deep_link) is absent — prefer {@link navigateForFlag}.
 */
export function navigateToEntity(
  entityType: string | null | undefined,
  entityId: string | null | undefined
): boolean {
  if (entityType == null || entityId == null) return false
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

/**
 * Navigate via a server-resolved `deep_link`. This is the primary path now that
 * the backend resolves the real target (e.g. a vial's deep_link points at its
 * parent sample — fixing the Plan-3 suppressed-arrow gap). Pure but for the
 * store side effects; returns false for `kind:"none"`.
 */
export function navigateToDeepLink(deepLink: DeepLink): boolean {
  const store = useUIStore.getState()
  switch (deepLink.kind) {
    case 'sample':
      store.closeFlagsFlyout()
      store.navigateToSample(deepLink.id)
      return true
    case 'worksheet':
      store.closeFlagsFlyout()
      store.openWorksheetDrawer(Number(deepLink.id))
      return true
    default:
      return false
  }
}

type EntityCarrier = Pick<FlagResponse, 'entity_type' | 'entity_id'> & {
  entity?: EntityContext | null
}

/** Navigate for a flag, preferring its resolved `entity.deep_link`, falling
 *  back to the entity-type heuristic when context is absent. */
export function navigateForFlag(flag: EntityCarrier): boolean {
  if (flag.entity?.deep_link) return navigateToDeepLink(flag.entity.deep_link)
  return navigateToEntity(flag.entity_type, flag.entity_id)
}

/** Best human label: the server-resolved one if present, else "Vial 42". */
export function entityDisplayLabel(flag: EntityCarrier): string {
  return flag.entity?.label ?? entityLabel(flag.entity_type, flag.entity_id)
}

/** Whether a flag has a usable navigation target (drives the chip's arrow). */
export function flagCanNavigate(flag: EntityCarrier): boolean {
  if (flag.entity?.deep_link) {
    return flag.entity.deep_link.kind !== 'none'
  }
  return entityMeta(flag.entity_type).canDeepLink
}
