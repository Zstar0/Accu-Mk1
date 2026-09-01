import type { BoardVial } from '@/lib/api'
import type { VialBoardFilters } from '@/lib/vial-board'

/**
 * Kanban view — PLACEHOLDER (Task 6). Task 7 replaces this body with the
 * real per-stage columns/cards; the prop contract below is load-bearing for
 * that task and for VialStatusPage's callsite, so keep it stable.
 *
 * `techNameById` is intentionally NOT part of this contract — the controller
 * ruling (task-6) has cards read `analyst_name` strings straight off the
 * board payload instead of joining through an id→user map.
 */
export interface VialBoardKanbanProps {
  vials: BoardVial[]
  filters: VialBoardFilters
  showAnalyses: boolean
  groupBySample: boolean
  collapsedCols: string[]
  onToggleCollapse: (key: string) => void
  roleShort: (code: string) => string
  roleChipClass: (code: string) => string
}

export function VialBoardKanban({ vials }: VialBoardKanbanProps) {
  return <div>Kanban — {vials.length} vials</div>
}
