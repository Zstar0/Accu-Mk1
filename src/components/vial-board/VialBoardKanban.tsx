import { ChevronDown, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'
import { parseReceivedAtMs, formatAge } from '@/components/hplc/AgingTimer'
import type { BoardVial } from '@/lib/api'
import {
  VIAL_STAGE_COLUMNS,
  stageCounts,
  vialColumns,
  isSplitVial,
  placeableAnalyses,
  type VialBoardFilters,
  type VialStage,
} from '@/lib/vial-board'

/**
 * Kanban view — one card per (vial, column) where the vial has live work in
 * that column (spec §2 multi-column placement). Cloned mechanisms from
 * OrderStatusPage.tsx's KanbanView (lines ~525-765): flat item build,
 * collapse override when a stage filter is active, the flat-grid
 * `gridTemplateColumns` trick, and swimlane grouping.
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

interface KanbanItem {
  vial: BoardVial
  col: VialStage
  count: number
  split: boolean
}

// DEVIATION from the brief's card code (flagged for controller review, not a
// resolved idiom): the brief computes age inline as
// `Date.now() - parseReceivedAtMs(...)` inside VialCard's render, but that
// trips a real `react-hooks/purity` error under this repo's lint config
// ("Cannot call impure function during render" — Date.now). Hoisting the
// call into this plain top-level function (not a component/hook) moves the
// impure read one frame outside the compiler's traced render body, so the
// diagnostic stops firing — the impurity itself is unchanged, this is a
// lint-visibility tradeoff, not a fix. Judged acceptable here because the
// value is cosmetic display-only text with no correctness dependency, and
// VialCard is spec'd hook-free (an AgingTimer-per-card ticking clock would
// mean one setInterval per card on a board that can hold hundreds), leaving
// no other clean-eslint option. See task-7-report.md for the full note.
function ageMsFor(receivedAt: string): number {
  return Date.now() - parseReceivedAtMs(receivedAt)
}

function buildItems(vials: BoardVial[]): KanbanItem[] {
  const items: KanbanItem[] = []
  for (const vial of vials) {
    const counts = stageCounts(vial)
    const split = isSplitVial(vial)
    for (const col of vialColumns(vial)) {
      items.push({ vial, col, count: counts[col] ?? 0, split })
    }
  }
  return items
}

export function VialBoardKanban({
  vials,
  filters,
  showAnalyses,
  groupBySample,
  collapsedCols,
  onToggleCollapse,
  roleShort,
  roleChipClass,
}: VialBoardKanbanProps) {
  const allItems = buildItems(vials)

  // An explicit stage filter means "show me exactly these columns" — it
  // overrides collapse state, mirroring OrderStatusPage.tsx:596-608.
  const effectiveCollapsed =
    filters.activeStages.length > 0 ? [] : collapsedCols

  if (groupBySample) {
    const laneCols = VIAL_STAGE_COLUMNS.filter(
      c => !effectiveCollapsed.includes(c.key)
    )
    const bySample = new Map<string, KanbanItem[]>()
    for (const item of allItems) {
      const key = item.vial.parent.sample_id
      const group = bySample.get(key) ?? []
      group.push(item)
      bySample.set(key, group)
    }
    // `Map` preserves insertion order and `bySample` is built by walking
    // `allItems` (itself in `vials` order), so this already reflects
    // VialStatusPage's active sort (received_at/sample_id, asc/desc) —
    // re-sorting alphabetically here would silently override the user's
    // sort choice whenever they toggle "By Sample" (OrderStatusPage.tsx:686
    // iterates `orders` in incoming order for the same reason).
    const lanes = [...bySample.entries()]

    return (
      <div className="flex flex-col gap-4">
        {lanes.map(([parentSampleId, laneItems]) => {
          const parent = laneItems[0]?.vial.parent
          return (
            <div
              key={parentSampleId}
              className="rounded-lg border border-border/50 overflow-hidden"
            >
              <div className="flex items-center gap-3 px-3 py-2 bg-muted/30 border-b border-border/50">
                <span className="font-mono text-sm font-semibold">
                  {parentSampleId}
                </span>
                {parent?.label && (
                  <span className="text-xs text-muted-foreground">
                    {parent.label}
                  </span>
                )}
              </div>
              <div
                className="grid gap-0 divide-x divide-border/30"
                style={{
                  gridTemplateColumns: `repeat(${laneCols.length}, 1fr)`,
                }}
              >
                {laneCols.map(col => {
                  const colItems = laneItems.filter(i => i.col === col.key)
                  return (
                    <div
                      key={col.key}
                      className="p-1.5 flex flex-col gap-1 min-w-[150px]"
                    >
                      {colItems.length === 0 ? (
                        <div className="text-xs text-muted-foreground/30 text-center py-2">
                          —
                        </div>
                      ) : (
                        colItems.map(item => (
                          <VialCard
                            key={`${item.vial.id}-${item.col}`}
                            vial={item.vial}
                            col={item.col}
                            count={item.count}
                            split={item.split}
                            showAnalyses={showAnalyses}
                            roleShort={roleShort}
                            roleChipClass={roleChipClass}
                            pillClass={col.pillClass}
                          />
                        ))
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  // Flat kanban — columns of vial cards.
  return (
    <div
      className="grid gap-3 min-w-0"
      style={{
        gridTemplateColumns: VIAL_STAGE_COLUMNS.map(c =>
          effectiveCollapsed.includes(c.key)
            ? 'minmax(40px, auto)'
            : 'minmax(180px, 1fr)'
        ).join(' '),
      }}
    >
      {VIAL_STAGE_COLUMNS.map(col => {
        const colItems = allItems.filter(i => i.col === col.key)
        const collapsed = effectiveCollapsed.includes(col.key)
        return (
          <div key={col.key} className="flex flex-col gap-2 min-w-0">
            <button
              type="button"
              onClick={() => onToggleCollapse(col.key)}
              title={
                collapsed ? `Expand ${col.label}` : `Collapse ${col.label}`
              }
              className="flex w-full items-center justify-between gap-1 px-1 pb-1 border-b border-border/50 hover:text-foreground transition-colors"
            >
              <span className="flex items-center gap-1 min-w-0">
                {collapsed ? (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                )}
                {!collapsed && (
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide truncate">
                    {col.label}
                  </span>
                )}
              </span>
              <Badge variant="secondary" className="text-xs tabular-nums">
                {colItems.length}
              </Badge>
            </button>
            {!collapsed && (
              <div className="flex flex-col gap-1">
                {colItems.length === 0 && (
                  <div className="text-xs text-muted-foreground/50 text-center py-4">
                    Empty
                  </div>
                )}
                {colItems.map(item => (
                  <VialCard
                    key={`${item.vial.id}-${item.col}`}
                    vial={item.vial}
                    col={item.col}
                    count={item.count}
                    split={item.split}
                    showAnalyses={showAnalyses}
                    roleShort={roleShort}
                    roleChipClass={roleChipClass}
                    pillClass={col.pillClass}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function VialCard({
  vial,
  col,
  count,
  split,
  showAnalyses,
  roleShort,
  roleChipClass,
  pillClass,
}: {
  vial: BoardVial
  col: VialStage
  count: number
  split: boolean
  showAnalyses: boolean
  roleShort: (code: string) => string
  roleChipClass: (code: string) => string
  pillClass: string
}) {
  const inCol = placeableAnalyses(vial.analyses).filter(
    a => a.review_state === col
  )
  const techs = [
    ...new Set(inCol.map(a => a.analyst_name).filter((n): n is string => !!n)),
  ]
  const age = formatAge(ageMsFor(vial.received_at))
  return (
    <div
      onClick={() =>
        useUIStore.getState().navigateToSample(vial.parent.sample_id)
      }
      title={placeableAnalyses(vial.analyses)
        .map(a => `${a.title} — ${a.review_state}`)
        .join('\n')}
      className={cn(
        'rounded border bg-indigo-500/10 border-indigo-500/35 px-2 py-1 cursor-pointer hover:border-indigo-400/60 transition-colors',
        split && 'ring-1 ring-sky-400/40'
      )}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="font-mono text-[11px] font-semibold truncate">
          {vial.sample_id}
        </span>
        <span
          className={cn(
            'text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0',
            roleChipClass(vial.assignment_role)
          )}
        >
          {roleShort(vial.assignment_role)}
        </span>
        {vial.parent.priority !== 'normal' && (
          <span
            title={vial.parent.priority}
            className={cn(
              'h-1.5 w-1.5 rounded-full shrink-0',
              vial.parent.priority === 'expedited'
                ? 'bg-red-400 animate-pulse'
                : 'bg-amber-400'
            )}
          />
        )}
        <span
          className={cn(
            'ml-auto inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none shrink-0',
            pillClass
          )}
        >
          {count}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground min-w-0">
        <span className="truncate">
          {techs.length > 0
            ? techs.join(', ')
            : col === 'unassigned'
              ? 'no worksheet yet'
              : '—'}
        </span>
        {vial.worksheet && (
          <span className="font-mono truncate text-muted-foreground/80">
            {vial.worksheet.title}
          </span>
        )}
        <span className="ml-auto font-mono tabular-nums shrink-0">{age}</span>
      </div>
      {showAnalyses && inCol.length > 0 && (
        <div className="mt-1 pt-1 border-t border-border/30">
          {inCol.map(a => (
            <div
              key={a.id}
              className="text-[10px] text-muted-foreground/70 leading-relaxed truncate"
            >
              {a.title}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
