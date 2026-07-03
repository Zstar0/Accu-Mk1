/**
 * Page-wide flag rollup from ONE query (Plan 6).
 *
 * Overview surfaces (the Order Status table + kanban, Customer detail) need a
 * flag indicator on every sample/order row. Rather than mount a per-row entity
 * query (a query storm on dense tables), this hook does a single
 * `GET /api/flags?tab=all_open` fetch and folds it into a
 * `Map<sampleId, FlagRollup>`. Vial (sub_sample) flags roll up under their
 * parent via the Plan-4 resolved `entity.sample_id`; sample flags key on their
 * own id. Colors resolve through {@link useFlagTypesMap} (the managed catalog,
 * inactive types included) so an edited or deactivated type still colors right.
 *
 * `rollupForSamples` merges several sample ids into one aggregate — an order
 * spans samples, so its indicator rolls up all of them.
 */

import { useFlagsList } from '@/hooks/use-flags'
import { useFlagTypesMap } from '@/services/flag-types'
import { flagTypeDef, type FlagTypeDef } from '@/components/flags/flag-catalog'
import type { FlagResponse } from '@/lib/flags-api'

// The states that still want attention (mirrors EntityFlagButton). The all_open
// tab already returns only these, but we filter defensively.
const OPEN_STATES = new Set(['open', 'in_progress', 'blocked'])

// Dominant-severity order for the indicator color when several types are open
// (blocker is the loudest). Matches EntityFlagButton's SEVERITY_ORDER.
const SEVERITY_ORDER: string[] = [
  'blocker',
  'critical',
  'waiting_on_customer',
  'question',
  'ready_for_verification',
]

function severityRank(type: string): number {
  const i = SEVERITY_ORDER.indexOf(type)
  return i === -1 ? SEVERITY_ORDER.length : i
}

/** The aggregate of one sample's (or one order's) open flags. */
export interface FlagRollup {
  count: number
  flags: FlagResponse[]
  /** Most-severe open type, or null when there are no flags. */
  dominantType: string | null
  /** Color of `dominantType` (managed catalog), or null when no flags. */
  dominantColor: string | null
}

const EMPTY_ROLLUP: FlagRollup = {
  count: 0,
  flags: [],
  dominantType: null,
  dominantColor: null,
}

/** The sample a flag rolls up to: its resolved parent (vials) else, for a
 *  sample-level flag, its own id. Null = doesn't belong to a sample (worksheet). */
function sampleKeyOf(flag: FlagResponse): string | null {
  const fromContext = flag.entity?.sample_id
  if (fromContext) return fromContext
  if (flag.entity_type === 'sample') return flag.entity_id
  return null
}

function dominantTypeOf(flags: FlagResponse[]): string | null {
  let best: string | null = null
  for (const f of flags) {
    if (best === null || severityRank(f.type) < severityRank(best))
      best = f.type
  }
  return best
}

/** Fold a flat open-flag list into a `sampleId → rollup` map. Pure (exported for
 *  tests); `typesMap` resolves the dominant color. */
export function buildRollupMap(
  flags: FlagResponse[],
  typesMap: Record<string, FlagTypeDef>
): Map<string, FlagRollup> {
  const groups = new Map<string, FlagResponse[]>()
  for (const flag of flags) {
    if (!OPEN_STATES.has(flag.status)) continue
    const key = sampleKeyOf(flag)
    if (!key) continue
    const arr = groups.get(key)
    if (arr) arr.push(flag)
    else groups.set(key, [flag])
  }

  const map = new Map<string, FlagRollup>()
  for (const [key, group] of groups) {
    const dominantType = dominantTypeOf(group)
    const dominantColor = dominantType
      ? (typesMap[dominantType]?.color ?? flagTypeDef(dominantType).color)
      : null
    map.set(key, {
      count: group.length,
      flags: group,
      dominantType,
      dominantColor,
    })
  }
  return map
}

/** Merge several samples' rollups into one aggregate (order scope). Pure;
 *  reuses a contributing sample's already-resolved color for the dominant type
 *  so it needs no `typesMap`. Dedupes repeated ids. */
export function rollupForSamples(
  map: Map<string, FlagRollup>,
  ids: string[]
): FlagRollup {
  const seen = new Set<string>()
  const flags: FlagResponse[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const r = map.get(id)
    if (r) flags.push(...r.flags)
  }
  if (flags.length === 0) return EMPTY_ROLLUP

  const dominantType = dominantTypeOf(flags)
  let dominantColor: string | null = null
  for (const id of seen) {
    const r = map.get(id)
    if (r && r.dominantType === dominantType) {
      dominantColor = r.dominantColor
      break
    }
  }
  return { count: flags.length, flags, dominantType, dominantColor }
}

/**
 * One all_open fetch → page-wide flag map. Reuses the existing list query/key
 * so SSE blanket-invalidation of `['flags']` refreshes every indicator. Returns
 * the `map` and a `rollupForSamples(ids)` bound to it for order rows.
 */
export function useOpenFlagsBySample(): {
  map: Map<string, FlagRollup>
  rollupForSamples: (ids: string[]) => FlagRollup
} {
  const { data } = useFlagsList('all_open')
  const typesMap = useFlagTypesMap()
  const map = buildRollupMap(data ?? [], typesMap)
  return { map, rollupForSamples: ids => rollupForSamples(map, ids) }
}
