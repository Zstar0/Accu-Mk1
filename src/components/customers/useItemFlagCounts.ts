import { useFlagsList } from '@/hooks/use-flags'

/** Open flags of one item type for one customer, counted per item: one
 *  request per tab, keyed by the entity id after `{customerKey}|`. */
export function useItemFlagCounts(
  entityType: 'support_ticket' | 'crm_item',
  customerKey: string
): Map<string, number> {
  const q = useFlagsList('all_open', { entity_type: entityType })
  const prefix = `${customerKey}|`
  const counts = new Map<string, number>()
  for (const f of q.data ?? []) {
    if (!f.entity_id?.startsWith(prefix)) continue
    const rest = f.entity_id.slice(prefix.length)
    counts.set(rest, (counts.get(rest) ?? 0) + 1)
  }
  return counts
}
