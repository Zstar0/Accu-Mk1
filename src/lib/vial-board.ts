// Pure, framework-free helpers for the Vial Status Board. See
// docs/superpowers/specs/2026-08-31-vial-status-board-design.md §5.
// No hooks, no store subscriptions (ast-grep hooks-in-hooks-dir applies).

export type VialStage =
  | 'unassigned'
  | 'assigned'
  | 'to_be_verified'
  | 'promoted'
  | 'variance_verified'
  | 'rejected'

export interface VialStageColumn {
  key: VialStage
  /** Keep labels in sync with STATUS_LABELS (components/senaite/AnalysisTable.tsx). */
  label: string
  /** Count-pill tint — static Tailwind literals (v4 scans source). */
  pillClass: string
}

// Single source for kanban column list/order/labels (spec §5 "Stage truth &
// forward-compat"): when the workflow catalog becomes authoritative after the
// authority swap, this constant flips to a catalog read (lims_workflow_states
// already carries label/category/sort_order) without touching either view.
export const VIAL_STAGE_COLUMNS: VialStageColumn[] = [
  { key: 'unassigned', label: 'Unassigned', pillClass: 'bg-zinc-500/15 text-zinc-400' },
  { key: 'assigned', label: 'Assigned', pillClass: 'bg-amber-500/15 text-amber-400' },
  { key: 'to_be_verified', label: 'To Verify', pillClass: 'bg-orange-500/15 text-orange-400' },
  { key: 'promoted', label: 'Promoted', pillClass: 'bg-teal-500/15 text-teal-400' },
  { key: 'variance_verified', label: 'Verified — Variance', pillClass: 'bg-teal-500/15 text-teal-400' },
  { key: 'rejected', label: 'Rejected', pillClass: 'bg-red-500/15 text-red-400' },
]

export const DEFAULT_COLLAPSED_COLUMNS: VialStage[] = ['rejected']

const STAGE_KEYS = new Set<string>(VIAL_STAGE_COLUMNS.map(c => c.key))

// Structural interfaces (inbox-filters.ts precedent) — keeps helpers testable
// with hand-built literals and decoupled from api.ts wire types, which
// satisfy these structurally.
export interface BoardAnalysisLike {
  title: string
  review_state: string
  analyst_user_id?: number | null
  analyst_name?: string | null
}

export interface BoardVialLike {
  sample_id: string
  assignment_role: string
  received_at: string
  parent: { sample_id: string; label?: string | null }
  analyses: BoardAnalysisLike[]
  worksheet?: { title: string } | null
}

/** Analyses that can place cards / feed matrix cells — retracted never
 *  counts (mirrors the worksheet analyst-stamping exclusion; spec §5). */
export function placeableAnalyses<A extends BoardAnalysisLike>(analyses: A[]): A[] {
  return analyses.filter(a => a.review_state !== 'retracted')
}

/** Per-column analysis counts for one vial (multi-column placement, spec §2). */
export function stageCounts(vial: BoardVialLike): Partial<Record<VialStage, number>> {
  const counts: Partial<Record<VialStage, number>> = {}
  for (const a of placeableAnalyses(vial.analyses)) {
    if (STAGE_KEYS.has(a.review_state)) {
      const stage = a.review_state as VialStage
      counts[stage] = (counts[stage] ?? 0) + 1
    }
  }
  return counts
}

/** Columns this vial's card appears in, in column order. */
export function vialColumns(vial: BoardVialLike): VialStage[] {
  const counts = stageCounts(vial)
  return VIAL_STAGE_COLUMNS.map(c => c.key).filter(k => (counts[k] ?? 0) > 0)
}

/** A vial with live work in more than one column gets the split outline. */
export function isSplitVial(vial: BoardVialLike): boolean {
  return vialColumns(vial).length > 1
}

// ── Filters (persisted as 'vial-board-filters', Order Status pattern) ──────

export interface VialBoardFilters {
  activeStages: string[]
  sampleIdFilter: string
  analyteFilter: string
  /** '' = all; else String(analyst_user_id) from the tech dropdown. */
  techFilter: string
  /** '' = all; else exact open-worksheet title. */
  worksheetFilter: string
  hideTestOrders: boolean
  showXtra: boolean
  showAnalyses: boolean
  collapsedCols: string[]
  viewMode: 'kanban' | 'table'
  groupBySample: boolean
  sortKey: 'received_at' | 'sample_id'
  sortDir: 'asc' | 'desc'
}

export const DEFAULT_VIAL_BOARD_FILTERS: VialBoardFilters = {
  activeStages: [],
  sampleIdFilter: '',
  analyteFilter: '',
  techFilter: '',
  worksheetFilter: '',
  hideTestOrders: true,
  showXtra: false,
  showAnalyses: false,
  collapsedCols: [...DEFAULT_COLLAPSED_COLUMNS],
  viewMode: 'kanban',
  groupBySample: false,
  sortKey: 'received_at',
  sortDir: 'asc',
}

export function vialMatchesSampleId(vial: BoardVialLike, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (
    vial.sample_id.toLowerCase().includes(needle) ||
    vial.parent.sample_id.toLowerCase().includes(needle)
  )
}

export function vialMatchesAnalyte(vial: BoardVialLike, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return placeableAnalyses(vial.analyses).some(a =>
    a.title.toLowerCase().includes(needle)
  )
}

export function vialMatchesTech(vial: BoardVialLike, techId: string): boolean {
  if (!techId) return true
  return placeableAnalyses(vial.analyses).some(
    a => a.analyst_user_id != null && String(a.analyst_user_id) === techId
  )
}

export function vialMatchesWorksheet(vial: BoardVialLike, title: string): boolean {
  if (!title) return true
  return vial.worksheet?.title === title
}

export function vialMatchesStages(vial: BoardVialLike, activeStages: string[]): boolean {
  if (activeStages.length === 0) return true
  return vialColumns(vial).some(c => activeStages.includes(c))
}

export function vialMatchesRole(vial: BoardVialLike, subRole: string): boolean {
  if (!subRole) return true
  return vial.assignment_role === subRole
}

/** One pass over the board rows applying lane + sub-role + every filter axis.
 *  laneRoleCodes null = no lane restriction (caller adds 'xtra' when the
 *  show-xtra toggle is on — the server already gates xtra server-side). */
export function applyBoardFilters<V extends BoardVialLike>(
  vials: V[],
  filters: Pick<
    VialBoardFilters,
    'activeStages' | 'sampleIdFilter' | 'analyteFilter' | 'techFilter' | 'worksheetFilter'
  >,
  laneRoleCodes: string[] | null,
  subRole: string
): V[] {
  return vials.filter(
    v =>
      (laneRoleCodes === null || laneRoleCodes.includes(v.assignment_role)) &&
      vialMatchesRole(v, subRole) &&
      vialMatchesStages(v, filters.activeStages) &&
      vialMatchesSampleId(v, filters.sampleIdFilter) &&
      vialMatchesAnalyte(v, filters.analyteFilter) &&
      vialMatchesTech(v, filters.techFilter) &&
      vialMatchesWorksheet(v, filters.worksheetFilter)
  )
}

export function sortVials<V extends BoardVialLike>(
  vials: V[],
  sortKey: 'received_at' | 'sample_id',
  sortDir: 'asc' | 'desc'
): V[] {
  const sorted = [...vials].sort((a, b) => {
    const cmp =
      sortKey === 'received_at'
        ? a.received_at.localeCompare(b.received_at)
        : a.sample_id.localeCompare(b.sample_id)
    return sortDir === 'asc' ? cmp : -cmp
  })
  return sorted
}

/** Toggle membership of key in a string-key list (order-filters.ts precedent). */
export function toggleKey(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]
}
