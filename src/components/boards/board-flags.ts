import type { BoardNode } from '@/lib/api-boards'
import type { FlagResponse } from '@/lib/flags-api'

/** Anchor key `type:id` for a flag or a node. */
export const anchorKey = (type: string | null, id: string | null) =>
  `${type ?? ''}:${id ?? ''}`

/** A generic item is anchored by its node id; an entity item by the entity behind it. */
export function nodeAnchor(
  node: Pick<BoardNode, 'id' | 'kind' | 'entity_type' | 'entity_id'>
): string {
  return node.kind === 'entity' && node.entity_type && node.entity_id
    ? anchorKey(node.entity_type, node.entity_id)
    : anchorKey('board_node', String(node.id))
}

export function flagsByAnchor(
  flags: FlagResponse[]
): Map<string, FlagResponse[]> {
  const out = new Map<string, FlagResponse[]>()
  for (const f of flags) {
    const k = anchorKey(f.entity_type, f.entity_id)
    out.set(k, [...(out.get(k) ?? []), f])
  }
  return out
}

export function blockingTypeSet(
  types: { slug: string; is_blocking: boolean }[] | undefined
): ReadonlySet<string> {
  return new Set((types ?? []).filter(t => t.is_blocking).map(t => t.slug))
}

/** Open flags on a frame and everything inside it (spec 8.3 rollup pills). */
export function frameRollup(
  flags: FlagResponse[],
  nodes: BoardNode[],
  frameId: number,
  blocking: ReadonlySet<string>
): { blocking: number; other: number } {
  const by = flagsByAnchor(flags)
  const anchors = [
    anchorKey('board_node', String(frameId)),
    ...nodes.filter(n => n.parent_id === frameId).map(nodeAnchor),
  ]
  let b = 0
  let o = 0
  for (const a of anchors)
    for (const f of by.get(a) ?? []) {
      if (blocking.has(f.type)) b += 1
      else o += 1
    }
  return { blocking: b, other: o }
}

export function assignedCount(
  flags: FlagResponse[],
  userId: number | null
): number {
  return userId == null ? 0 : flags.filter(f => f.assignee_id === userId).length
}

const DAY = 86_400_000

/** 'overdue Nd', 'due today', 'due in Nd', or null without a due date. */
export function dueLabel(due: string | null, now: Date): string | null {
  if (!due) return null
  const days = Math.floor((new Date(due).getTime() - now.getTime()) / DAY)
  if (days < 0) return `overdue ${-days}d`
  if (days === 0) return 'due today'
  return `due in ${days}d`
}

/** Blocking or past-due flags, overdue first (earliest due first), then blocking by recency (spec 8.6). */
export function attentionList(
  flags: FlagResponse[],
  blocking: ReadonlySet<string>,
  now: Date
): FlagResponse[] {
  const overdue = (f: FlagResponse) =>
    !!f.due_at && new Date(f.due_at).getTime() < now.getTime()
  const picked = flags.filter(f => overdue(f) || blocking.has(f.type))
  return picked.sort((a, b) => {
    const oa = overdue(a)
    const ob = overdue(b)
    if (oa !== ob) return oa ? -1 : 1
    if (oa && ob)
      return (
        new Date(a.due_at as string).getTime() -
        new Date(b.due_at as string).getTime()
      )
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  })
}

/** The node to centre for a flag: the item for board_node and entity anchors, none for the board. */
export function locateTargetFor(
  flag: FlagResponse,
  nodes: BoardNode[]
): number | null {
  if (flag.entity_type === 'board_node') {
    const id = Number(flag.entity_id)
    return nodes.some(n => n.id === id) ? id : null
  }
  if (flag.entity_type === 'board' || !flag.entity_type || !flag.entity_id)
    return null
  const hit = nodes.find(
    n =>
      n.kind === 'entity' &&
      n.entity_type === flag.entity_type &&
      n.entity_id === flag.entity_id
  )
  return hit ? hit.id : null
}
