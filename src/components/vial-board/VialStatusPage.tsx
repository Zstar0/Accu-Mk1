import { useEffect, useState } from 'react'
import { RefreshCw, Columns3, LayoutList, Layers, ListTree } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useInboxLanes } from '@/services/inbox-lanes'
import { useVialRoles } from '@/services/vial-roles'
import { useDepartments } from '@/services/departments'
import { useVialBoard } from '@/services/vial-board'
import { useFlagUsers, nameForUser } from '@/components/flags/flag-users'
import {
  ROLE_COLOR_BADGE,
  ROLE_COLOR_CHIP,
  roleColorForCode,
  roleShortLabel,
  roleFullLabel,
} from '@/lib/role-display'
import {
  VIAL_STAGE_COLUMNS,
  type VialBoardFilters,
  applyBoardFilters,
  sortVials,
  toggleKey,
  loadVialBoardFilters,
  saveVialBoardFilters,
  loadStoredBoardLane,
  VIAL_BOARD_LANE_LS_KEY,
} from '@/lib/vial-board'
import { VialBoardKanban } from '@/components/vial-board/VialBoardKanban'
import { VialBoardMatrix } from '@/components/vial-board/VialBoardMatrix'
import type { VialRoleRow } from '@/services/vial-roles'

/** Sub-chips for a lane's role codes, sorted by catalog sort_order then code
 *  (WorksheetsInboxPage.tsx:180-194 idiom). A plain function, not `useMemo`:
 *  wrapping it in `useMemo` here trips react-hooks/preserve-manual-memoization
 *  (the compiler-based lint reports it cannot verify `currentLane` is stable
 *  across renders and skips optimizing the component) — sorting a handful of
 *  role codes is cheap enough not to need memoization anyway. */
function laneSubChipsFor(
  codes: string[],
  roles: VialRoleRow[] | undefined
): { value: string; label: string }[] {
  if (codes.length < 2) return []
  const byCode = new Map((roles ?? []).map(r => [r.code, r]))
  return [...codes]
    .sort((a, b) => {
      const ra = byCode.get(a)
      const rb = byCode.get(b)
      return (ra?.sort_order ?? 999) - (rb?.sort_order ?? 999) || a.localeCompare(b)
    })
    .map(code => ({ value: code, label: byCode.get(code)?.label ?? code }))
}

/**
 * Vial Status Board — department-scoped kanban/matrix over sub-samples
 * (spec docs/superpowers/specs/2026-08-31-vial-status-board-design.md).
 * Read-only v1: cards click through to sample details; stage changes stay
 * in worksheets/verify flows.
 */
export function VialStatusPage() {
  const lanesQ = useInboxLanes()
  const lanes = lanesQ.data ?? []
  const vialRolesQ = useVialRoles()
  const departmentsQ = useDepartments()
  const userMap = useFlagUsers()

  // Catalog color for a lane key, IF it's a real vial-role code — a lane
  // whose key spans multiple role codes (e.g. 'microbiology') isn't itself a
  // role and falls back to the neutral-violet look (WorksheetsInboxPage
  // precedent — laneBadgeClass is not exported there, so re-declared here).
  const laneBadgeClass = (key: string): string =>
    vialRolesQ.data?.some(r => r.code === key)
      ? ROLE_COLOR_BADGE[roleColorForCode(key, vialRolesQ.data, departmentsQ.data)]
      : 'bg-violet-500/15 text-violet-700 border-violet-500/40 dark:text-violet-300'

  // Lane persistence: raw stored key, validated against the fetched lane set
  // (WorksheetsInboxPage.tsx:142-172 idiom — a stale admin-deleted key must
  // never 400; `lane` is DERIVED, not stateful, and is null only until lanes
  // resolve).
  const [storedLane, setStoredLane] = useState<string | null>(loadStoredBoardLane)
  const [firstLane] = lanes
  const lane: string | null = firstLane
    ? lanes.some(l => l.key === storedLane)
      ? storedLane
      : firstLane.key
    : null
  const currentLane = lanes.find(l => l.key === lane)

  useEffect(() => {
    if (lane !== null) window.localStorage.setItem(VIAL_BOARD_LANE_LS_KEY, lane)
  }, [lane])

  // Persisted filter blob (Order Status pattern).
  const [filters, setFilters] = useState<VialBoardFilters>(loadVialBoardFilters)
  const updateFilters = (partial: Partial<VialBoardFilters>) => {
    setFilters(prev => {
      const next = { ...prev, ...partial }
      saveVialBoardFilters(next)
      return next
    })
  }

  // Sub-role selection is transient and resets on lane change (inbox
  // precedent — a stale sub-role from a foreign lane must never survive).
  // Reset during render — React's documented "adjusting state when a prop
  // changes" idiom (not an effect): tracking the lane we last reset for lets
  // this run as a plain render-time state adjustment, which needs no
  // react-hooks/set-state-in-effect suppression at all.
  const [subRole, setSubRole] = useState('')
  const [prevLane, setPrevLane] = useState<string | null>(null)
  if (lane !== prevLane) {
    setPrevLane(lane)
    if (subRole !== '') setSubRole('')
  }

  const boardQ = useVialBoard({
    hideTestOrders: filters.hideTestOrders,
    showXtra: filters.showXtra,
  })

  const allVials = boardQ.data?.vials ?? []

  // Lane's role codes plus 'xtra' when the show-xtra toggle is on (the server
  // already gates xtra server-side; the client needs the expanded set both
  // to filter the active lane's vials and to count each lane chip).
  const currentLaneCodesFor = (l: { role_codes: string[] }): string[] => [
    ...l.role_codes,
    ...(filters.showXtra ? ['xtra'] : []),
  ]

  const laneCodes = currentLane ? currentLaneCodesFor(currentLane) : null
  const vials = sortVials(
    applyBoardFilters(allVials, filters, laneCodes, subRole),
    filters.sortKey,
    filters.sortDir
  )

  // Sub-chips for the ACTIVE lane, one per role the lane's department owns —
  // rendered only when there is more than one (WorksheetsInboxPage.tsx:180-194).
  const laneSubChips = laneSubChipsFor(currentLane?.role_codes ?? [], vialRolesQ.data)

  // Faceted sub-chip counts: what clicking each chip yields under the active
  // text/tech/worksheet/stage filters, ignoring the sub-role filter itself
  // (WorksheetsInboxPage.tsx:681-685 `subChipCounts` idiom). '' = the lane's
  // "All" chip total.
  const subRoleFacetVials = applyBoardFilters(allVials, filters, laneCodes, '')
  const subChipCounts = new Map<string, number>()
  subChipCounts.set('', subRoleFacetVials.length)
  for (const c of laneSubChips) {
    subChipCounts.set(
      c.value,
      subRoleFacetVials.filter(v => v.assignment_role === c.value).length
    )
  }

  // Distinct open-worksheet titles present on the board, for the worksheet
  // filter dropdown.
  const worksheetTitles = [
    ...new Set(allVials.map(v => v.worksheet?.title).filter((t): t is string => !!t)),
  ].sort()

  // Never render half a board: a lanes or board fetch failure gets a single
  // retry affordance, not a partially-rendered toolbar over an empty grid.
  if (lanesQ.isError || boardQ.isError) {
    const err = lanesQ.error ?? boardQ.error
    return (
      <div className="h-[calc(100vh-4rem)] overflow-hidden p-6">
        <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-destructive/30 bg-destructive/5 py-12">
          <p className="text-sm text-destructive font-medium">
            {err instanceof Error ? err.message : 'Failed to load the vial board'}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              lanesQ.refetch()
              boardQ.refetch()
            }}
            className="gap-2"
          >
            <RefreshCw className="size-4" />
            Retry
          </Button>
        </div>
      </div>
    )
  }

  // Loading covers lanes-in-flight, the lane-validation gate (lane === null
  // until lanes resolve), and the board query itself.
  if (lanesQ.isLoading || lane === null || boardQ.isLoading) {
    return (
      <div className="h-[calc(100vh-4rem)] overflow-hidden p-6">
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-lg border p-4 animate-pulse">
              <div className="flex items-center gap-3 mb-3">
                <div className="h-4 w-16 rounded bg-muted" />
                <div className="h-5 w-20 rounded bg-muted" />
              </div>
              <div className="space-y-2">
                <div className="h-3 w-48 rounded bg-muted" />
                <div className="h-3 w-36 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Human-readable list of the filters currently narrowing the board, for the
  // empty state's "why is this empty" hint.
  const activeFilterSummary: string[] = []
  if (currentLane) activeFilterSummary.push(currentLane.label)
  if (subRole) {
    activeFilterSummary.push(laneSubChips.find(c => c.value === subRole)?.label ?? subRole)
  }
  if (filters.sampleIdFilter) activeFilterSummary.push(`Sample ID "${filters.sampleIdFilter}"`)
  if (filters.analyteFilter) activeFilterSummary.push(`Analyte "${filters.analyteFilter}"`)
  if (filters.techFilter) {
    activeFilterSummary.push(`Tech ${nameForUser(userMap, Number(filters.techFilter))}`)
  }
  if (filters.worksheetFilter) {
    activeFilterSummary.push(`Worksheet "${filters.worksheetFilter}"`)
  }
  if (filters.activeStages.length > 0) {
    activeFilterSummary.push(`Stages: ${filters.activeStages.join(', ')}`)
  }
  if (filters.hideTestOrders) activeFilterSummary.push('test orders hidden')

  return (
    <div className="h-[calc(100vh-4rem)] overflow-y-auto p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Vial Status</h1>
            <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-sm font-medium text-muted-foreground">
              {vials.length} vial{vials.length === 1 ? '' : 's'}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Read-only view of in-flight vials by stage
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => boardQ.refetch()}
          className="gap-2"
        >
          <RefreshCw className={cn('size-3.5', boardQ.isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Lane chips — one per catalog-driven lane (parity with the worksheets
        inbox). The count-per-lane (brief §5b) is surfaced as a `title`
        tooltip rather than visible text — the component test pins the exact
        accessible name `{ name: 'Analytical' }`, and a visible count span
        would change it to "Analytical 12". */}
      <div className="mb-3 flex items-center gap-2">
        {lanes.map(l => {
          const laneCount = allVials.filter(v =>
            currentLaneCodesFor(l).includes(v.assignment_role)
          ).length
          return (
            <button
              key={l.key}
              type="button"
              onClick={() => setStoredLane(l.key)}
              title={`${laneCount} vial${laneCount === 1 ? '' : 's'}`}
              className={cn(
                'inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium transition-colors',
                lane === l.key
                  ? laneBadgeClass(l.key)
                  : 'bg-transparent text-muted-foreground border-border hover:bg-muted/40'
              )}
            >
              {l.label}
            </button>
          )
        })}
      </div>

      {/* Lane sub-chips — one per role the active lane's department owns
        (renders only for multi-role lanes). Faceted counts unlike the lane
        row above: the test never pins these buttons' names. */}
      {laneSubChips.length > 0 && (
        <div className="mb-6 flex items-center gap-1.5 pl-4">
          <span className="text-muted-foreground/40 select-none" aria-hidden="true">
            &#8627;
          </span>
          {[{ value: '', label: 'All' }, ...laneSubChips].map(c => (
            <button
              key={c.value || 'all'}
              type="button"
              onClick={() => setSubRole(c.value)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
                subRole === c.value
                  ? laneBadgeClass(c.value)
                  : 'bg-transparent text-muted-foreground border-border hover:bg-muted/40'
              )}
            >
              {c.label}
              <span className="tabular-nums text-[10px] opacity-60">
                {subChipCounts.get(c.value) ?? 0}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Sample / Vial ID"
          value={filters.sampleIdFilter}
          onChange={e => updateFilters({ sampleIdFilter: e.target.value })}
          className="h-8 w-44 text-sm"
        />
        <Input
          placeholder="Analyte"
          value={filters.analyteFilter}
          onChange={e => updateFilters({ analyteFilter: e.target.value })}
          className="h-8 w-40 text-sm"
        />
        <select
          value={filters.techFilter}
          onChange={e => updateFilters({ techFilter: e.target.value })}
          className="h-8 rounded-md border border-border bg-transparent px-2 text-sm text-muted-foreground"
        >
          <option value="">All techs</option>
          {[...userMap.values()].map(u => (
            <option key={u.id} value={String(u.id)}>
              {nameForUser(userMap, u.id)}
            </option>
          ))}
        </select>
        <select
          value={filters.worksheetFilter}
          onChange={e => updateFilters({ worksheetFilter: e.target.value })}
          className="h-8 rounded-md border border-border bg-transparent px-2 text-sm text-muted-foreground"
        >
          <option value="">All worksheets</option>
          {worksheetTitles.map(title => (
            <option key={title} value={title}>
              {title}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => updateFilters({ hideTestOrders: !filters.hideTestOrders })}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium border transition-colors',
            filters.hideTestOrders
              ? 'bg-foreground text-background border-foreground'
              : 'bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'
          )}
        >
          Hide test orders
        </button>
        <button
          type="button"
          onClick={() => updateFilters({ showXtra: !filters.showXtra })}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium border transition-colors',
            filters.showXtra
              ? 'bg-foreground text-background border-foreground'
              : 'bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'
          )}
        >
          Show xtra
        </button>

        <div className="flex items-center gap-1 ml-auto">
          {filters.viewMode === 'kanban' && (
            <>
              <button
                type="button"
                title="Group cards by sample"
                onClick={() => updateFilters({ groupBySample: !filters.groupBySample })}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition-colors',
                  filters.groupBySample
                    ? 'bg-foreground text-background border-foreground'
                    : 'bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'
                )}
              >
                <Layers className="h-3.5 w-3.5" />
                By Sample
              </button>
              <button
                type="button"
                title="Show analyses in each card"
                onClick={() => updateFilters({ showAnalyses: !filters.showAnalyses })}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition-colors',
                  filters.showAnalyses
                    ? 'bg-foreground text-background border-foreground'
                    : 'bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'
                )}
              >
                <ListTree className="h-3.5 w-3.5" />
                Analyses
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    title="Choose which kanban columns are shown"
                    className={cn(
                      'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition-colors',
                      filters.collapsedCols.length > 0
                        ? 'bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'
                        : 'bg-foreground text-background border-foreground'
                    )}
                  >
                    <Columns3 className="h-3.5 w-3.5" />
                    Columns
                    {filters.collapsedCols.length > 0 && (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-mono leading-none">
                        {VIAL_STAGE_COLUMNS.length - filters.collapsedCols.length}/
                        {VIAL_STAGE_COLUMNS.length}
                      </span>
                    )}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuLabel className="text-xs">Kanban columns</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {VIAL_STAGE_COLUMNS.map(col => (
                    <DropdownMenuCheckboxItem
                      key={col.key}
                      className="text-xs"
                      checked={!filters.collapsedCols.includes(col.key)}
                      onSelect={e => e.preventDefault()}
                      onCheckedChange={() =>
                        updateFilters({ collapsedCols: toggleKey(filters.collapsedCols, col.key) })
                      }
                    >
                      {col.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
          <button
            type="button"
            title="Table view"
            onClick={() => updateFilters({ viewMode: 'table' })}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition-colors',
              filters.viewMode === 'table'
                ? 'bg-foreground text-background border-foreground'
                : 'bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'
            )}
          >
            <LayoutList className="h-3.5 w-3.5" />
            Table
          </button>
          <button
            type="button"
            title="Kanban view"
            onClick={() => updateFilters({ viewMode: 'kanban' })}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition-colors',
              filters.viewMode === 'kanban'
                ? 'bg-foreground text-background border-foreground'
                : 'bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'
            )}
          >
            <Columns3 className="h-3.5 w-3.5" />
            Kanban
          </button>
        </div>
      </div>

      {/* Stage filter chips (both views). */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {VIAL_STAGE_COLUMNS.map(col => {
          const active = filters.activeStages.includes(col.key)
          return (
            <button
              key={col.key}
              type="button"
              onClick={() =>
                updateFilters({ activeStages: toggleKey(filters.activeStages, col.key) })
              }
              className={cn(
                'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
                active
                  ? col.pillClass
                  : 'bg-transparent text-muted-foreground border-border hover:bg-muted/40'
              )}
            >
              {col.label}
            </button>
          )
        })}
      </div>

      {vials.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border py-16 text-center">
          <p className="text-sm font-medium text-muted-foreground">
            No vials match the current filters
          </p>
          {activeFilterSummary.length > 0 && (
            <p className="text-xs text-muted-foreground/60">
              Active: {activeFilterSummary.join(' · ')}
            </p>
          )}
        </div>
      ) : filters.viewMode === 'kanban' ? (
        <VialBoardKanban
          vials={vials}
          filters={filters}
          showAnalyses={filters.showAnalyses}
          groupBySample={filters.groupBySample}
          collapsedCols={filters.collapsedCols}
          onToggleCollapse={key =>
            updateFilters({ collapsedCols: toggleKey(filters.collapsedCols, key) })
          }
          roleShort={code => roleShortLabel(code, vialRolesQ.data)}
          roleChipClass={code =>
            ROLE_COLOR_CHIP[roleColorForCode(code, vialRolesQ.data, departmentsQ.data)]
          }
        />
      ) : (
        <VialBoardMatrix
          vials={vials}
          roleCodes={currentLane?.role_codes ?? []}
          roleLabel={code => roleFullLabel(code, vialRolesQ.data)}
        />
      )}
    </div>
  )
}
