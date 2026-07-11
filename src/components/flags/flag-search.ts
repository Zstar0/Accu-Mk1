/**
 * Fold server comment-search hits into the flyout's client-filtered list.
 *
 * The instant client-side filter (title / Sample ID substring — `filterFlags`)
 * stays the source of truth for visibility; this only ADDS flags the SERVER
 * matched on a comment body, which the client can't see because comment bodies
 * aren't in the list payload. Title-only server hits need no augmentation (the
 * client already matches titles), so they never add rows. Returns the visible
 * list (client matches first, then comment-only extras in tab order) plus a
 * per-flag-id map of the snippet for the "matched in comments" badge.
 */
import type { FlagResponse, FlagSearchHit } from '@/lib/flags-api'

export interface FlagSearchMeta {
  snippet: string
}

export function mergeSearchHits(
  tabFlags: FlagResponse[],
  clientVisible: FlagResponse[],
  hits: FlagSearchHit[]
): { flags: FlagResponse[]; searchMeta: Map<number, FlagSearchMeta> } {
  const commentHitById = new Map(
    hits.filter(h => h.matched_in.includes('comment')).map(h => [h.flag_id, h])
  )
  const visibleIds = new Set(clientVisible.map(f => f.id))
  const extras = tabFlags.filter(
    f => !visibleIds.has(f.id) && commentHitById.has(f.id)
  )
  const flags = [...clientVisible, ...extras]

  const searchMeta = new Map<number, FlagSearchMeta>()
  for (const f of flags) {
    const h = commentHitById.get(f.id)
    if (h) searchMeta.set(f.id, { snippet: h.snippet })
  }
  return { flags, searchMeta }
}
