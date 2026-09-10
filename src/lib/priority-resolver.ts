import type { EffectivePriority, PriorityLevel } from '@/lib/api-priorities'

const LEVELS: PriorityLevel[] = ['vial', 'sample', 'order', 'customer']
interface Info {
  key: string
  rank: number
  is_active: boolean
  is_default: boolean
}

/** Most specific explicit ACTIVE key wins; unknown/inactive = inherit; else default.
 *  Mirror of backend/priority/resolver.py; both run the shared fixture. */
export function resolvePriority(
  explicit: Partial<Record<PriorityLevel, string | null>>,
  priorities: Info[],
  ids: Partial<Record<PriorityLevel, string>> = {}
): EffectivePriority {
  const byKey = new Map(priorities.map(p => [p.key, p]))
  for (const level of LEVELS) {
    const key = explicit[level]
    if (!key) continue
    const info = byKey.get(key)
    if (!info || !info.is_active) continue
    return {
      key: info.key,
      rank: info.rank,
      source_level: level,
      source_id: ids[level] ?? null,
    }
  }
  const def = priorities.find(p => p.is_default)
  if (!def) throw new Error('no default priority configured')
  return {
    key: def.key,
    rank: def.rank,
    source_level: 'default',
    source_id: null,
  }
}
