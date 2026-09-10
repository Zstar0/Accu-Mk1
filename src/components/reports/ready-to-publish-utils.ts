/**
 * Ready to Publish — pure helpers.
 *
 * The backend (`GET /reports/ready-to-publish`) returns rows already sorted
 * most-critical-first (SLA red → amber → green → none, least time remaining,
 * priority, oldest received). Grouping by order must not disturb that: a
 * group takes the position of its FIRST (most critical) row, and rows inside
 * a group keep their server order. Nothing here re-sorts.
 */
import type { ReadyReason, ReadyRow, ReadySla } from '@/lib/api'

export interface ReadyOrderGroup {
  order: string
  client: string | null
  email: string | null
  created_at: string | null
  rows: ReadyRow[]
  /** Worst SLA colour across the group's rows; null when no row has an SLA. */
  worst: ReadySla['color'] | null
  breached: number
}

const COLOR_RANK: Record<ReadySla['color'], number> = {
  red: 0,
  amber: 1,
  green: 2,
}

export function worstColor(rows: ReadyRow[]): ReadySla['color'] | null {
  let worst: ReadySla['color'] | null = null
  for (const r of rows) {
    const c = r.sla?.color
    if (!c) continue
    if (worst === null || COLOR_RANK[c] < COLOR_RANK[worst]) worst = c
  }
  return worst
}

/** Group rows by order number, preserving the server's critical-first order
 *  both across groups (first-appearance) and within each group. Rows with an
 *  empty order number land in a single "—" group. */
export function groupByOrder(rows: ReadyRow[]): ReadyOrderGroup[] {
  const groups = new Map<string, ReadyOrderGroup>()
  for (const row of rows) {
    const key = row.order || '—'
    let g = groups.get(key)
    if (!g) {
      g = {
        order: key,
        client: row.client,
        email: row.email,
        created_at: row.created_at,
        rows: [],
        worst: null,
        breached: 0,
      }
      groups.set(key, g)
    }
    g.rows.push(row)
    if (!g.client && row.client) g.client = row.client
    if (!g.email && row.email) g.email = row.email
    if (row.sla?.breached) g.breached += 1
  }
  for (const g of groups.values()) g.worst = worstColor(g.rows)
  return [...groups.values()]
}

export const REASON_LABEL: Record<ReadyReason, string> = {
  all_verified: 'All lines verified',
  flag_ready: 'Flag: Ready for Publish',
  flag_partial: 'Flag: Ready for Partial Publish',
}

/** One-line reason summary, in the backend's fixed order. */
export function reasonText(reasons: ReadyReason[]): string {
  return reasons.map(r => REASON_LABEL[r] ?? r).join(' · ')
}

/** "3/4 verified · pending: STER-PCR" for the sub-line. */
export function linesText(lines: ReadyRow['lines']): string {
  const base = `${lines.verified}/${lines.total} verified`
  return lines.pending.length
    ? `${base} · pending: ${lines.pending.join(', ')}`
    : base
}

/** Filter helper for the page's text box: matches order, sample, client,
 *  email, lot or analyte, case-insensitively. */
export function matchesQuery(row: ReadyRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = [
    row.order,
    row.sample_id,
    row.client ?? '',
    row.email ?? '',
    row.lot ?? '',
    ...row.analytes,
  ]
  return hay.some(h => h.toLowerCase().includes(q))
}
