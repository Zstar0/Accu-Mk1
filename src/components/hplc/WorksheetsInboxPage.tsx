import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { useEffect, useMemo, useState } from 'react'
import { HelpCircle, Inbox, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ROLE_COLOR_BADGE, roleColorForCode } from '@/lib/role-display'
import { useVialRoles } from '@/services/vial-roles'
import { useDepartments } from '@/services/departments'
import { useEffectiveReadSource } from '@/lib/read-source'
import { toast } from 'sonner'
import { InboxVialCard, type DragData } from '@/components/hplc/InboxVialCard'
import { InboxFamilyGroup } from '@/components/hplc/InboxFamilyGroup'
import {
  groupInboxFamilies,
  varianceParentIds,
  type FamilyDragData,
} from '@/lib/inbox-families'
import { WorksheetDropPanel } from '@/components/hplc/WorksheetDropPanel'
import { vialMatchesSampleId, vialMatchesAnalyte } from '@/lib/inbox-filters'
import { useInboxSamples, usePriorityMutation } from '@/hooks/use-inbox-samples'
import {
  getWorksheetUsers,
  getInboxSamples,
  fetchSampleAggregates,
  listWorksheets,
  type InboxVialItem,
  addGroupToWorksheet,
  createWorksheetFromDrop,
  updateWorksheet,
  deleteWorksheet,
  removeWorksheetItem,
  type InboxPriority,
} from '@/lib/api'
import { useInboxLanes } from '@/services/inbox-lanes'
import { useServiceGroups } from '@/services/service-groups'
import { useSlaForSubjects } from '@/services/sla-subjects'
import { buildInboxSlaSubjects, departmentToGroupId } from '@/lib/inbox-sla'

// Lane sub-chips are catalog-driven (sub-chips slice, 2026-08-24): any lane
// whose department owns MORE THAN ONE vial role renders one chip per role
// (plus All), labeled/colored from the role catalog and filtering by the
// vial's role_tags — the vial's own role plus rider profiles' roles from
// custody edges, so rider work (fentanyl riding an hplc host) is reachable
// under its own chip. Replaces the hardcoded MICRO_SUBCHIPS constant and its
// keyword-category filter (the S1 hardcoded-role-map class): endo/ster under
// Microbiology now derive from the catalog, and a new role created in the
// admin UI gets its sub-chip with no code change.

// localStorage keys for filter persistence (per the spec UI section)
const STORAGE_ROLE_KEY = 'accu_mk1_worksheet_inbox_role'
const STORAGE_SHOW_XTRA_KEY = 'accu_mk1_worksheet_inbox_show_xtra'
const STORAGE_HIDE_TEST_KEY = 'accu_mk1_worksheet_inbox_hide_test_orders'

/** Raw stored lane key, unvalidated (spec 4, Task 10 — lanes are catalog-
 *  driven now, so validity can only be checked once GET /worksheets/inbox/
 *  lanes has resolved; see the `role` derivation in WorksheetsInboxPage). */
function loadStoredRole(): string | null {
  return typeof window !== 'undefined'
    ? window.localStorage.getItem(STORAGE_ROLE_KEY)
    : null
}

function loadStoredShowXtra(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(STORAGE_SHOW_XTRA_KEY) === 'true'
}

function loadStoredHideTestOrders(): boolean {
  // Default to true (the production-safe behavior). Persisted so a tester who
  // unchecks it once doesn't get reset every page load.
  if (typeof window === 'undefined') return true
  const v = window.localStorage.getItem(STORAGE_HIDE_TEST_KEY)
  return v === null ? true : v === 'true'
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

function CardSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-lg border p-4 animate-pulse">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-4 w-16 rounded bg-muted" />
            <div className="h-5 w-20 rounded bg-muted" />
            <div className="flex-1" />
            <div className="h-4 w-16 rounded bg-muted" />
            <div className="h-4 w-12 rounded bg-muted" />
          </div>
          <div className="space-y-2">
            <div className="h-3 w-48 rounded bg-muted" />
            <div className="h-3 w-36 rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
//
// Vial-flat inbox: one card per vial (parent or sub-sample). Server-side
// sorting groups same-family vials adjacently (parent first, then subs by
// vial_sequence); the only client-side sort is the priority pass below.

export default function WorksheetsInboxPage() {
  const queryClient = useQueryClient()
  const [hideTestOrders, setHideTestOrders] = useState<boolean>(
    loadStoredHideTestOrders
  )
  const [hidePrepped, setHidePrepped] = useState(true)
  const [showXtra, setShowXtra] = useState<boolean>(loadStoredShowXtra)
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Bench filter lanes are catalog-driven (spec 4, Task 10) — GET
  // /worksheets/inbox/lanes, not a hardcoded HPLC/Microbiology pair. hm
  // (Heavy Metals) was UNREACHABLE from this UI before this task even though
  // it shipped as a role in spec-3 — see the regression test in
  // worksheets-inbox-lanes.test.tsx.
  const lanesQ = useInboxLanes()
  const lanes = lanesQ.data ?? []
  const vialRolesQ = useVialRoles()
  const departmentsQ = useDepartments()
  // Catalog color for a lane/sub-chip key, IF it's a real vial-role code —
  // 'microbiology' spans two role codes and isn't itself one, so it (and the
  // 'All' sub-chip's empty value) keep the neutral-violet fallback below.
  const laneBadgeClass = (key: string): string =>
    vialRolesQ.data?.some(r => r.code === key)
      ? ROLE_COLOR_BADGE[
          roleColorForCode(key, vialRolesQ.data, departmentsQ.data)
        ]
      : 'bg-violet-500/15 text-violet-700 border-violet-500/40 dark:text-violet-300'

  // Raw stored preference; validated below against the fetched lane set —
  // an admin-deleted department's stale key must never reach the inbox
  // fetch (it would 400). `role` is derived, not stateful: it's null only
  // while lanes haven't resolved yet.
  const [storedRole, setStoredRole] = useState<string | null>(loadStoredRole)
  const [firstLane] = lanes
  const role: string | null = firstLane
    ? lanes.some(l => l.key === storedRole)
      ? storedRole
      : firstLane.key
    : null
  const currentLane = lanes.find(l => l.key === role)

  // Client-side inbox filters (transient — not persisted). Sample-ID applies to
  // both benches; analyte is HPLC-only; micro-category is Micro-only.
  const [sampleIdFilter, setSampleIdFilter] = useState('')
  const [analyteFilter, setAnalyteFilter] = useState('')
  const [subRole, setSubRole] = useState('') // '' = all roles in the lane

  // Persist filter selections so the tech's last filter sticks across sessions.
  // Persists the VALIDATED role (not the raw stored value) so a stale key
  // self-heals to the fallback lane durably, not just for this session.
  useEffect(() => {
    if (role !== null) window.localStorage.setItem(STORAGE_ROLE_KEY, role)
  }, [role])
  useEffect(() => {
    window.localStorage.setItem(STORAGE_SHOW_XTRA_KEY, String(showXtra))
  }, [showXtra])
  useEffect(() => {
    window.localStorage.setItem(STORAGE_HIDE_TEST_KEY, String(hideTestOrders))
  }, [hideTestOrders])

  // Sub-chips for the ACTIVE lane, one per role the lane's department owns —
  // rendered only when there is more than one (a single-role lane needs no
  // sub-filter). Ordered and labeled from the role catalog (S1 display
  // faces); a lane role code the roles query hasn't resolved yet still gets
  // a chip with the bare code as its label (fail-open display, never a
  // dropped filter).
  const laneSubChips = useMemo(() => {
    const codes = currentLane?.role_codes ?? []
    if (codes.length < 2) return []
    const byCode = new Map((vialRolesQ.data ?? []).map(r => [r.code, r]))
    return [...codes]
      .sort((a, b) => {
        const ra = byCode.get(a)
        const rb = byCode.get(b)
        return (
          (ra?.sort_order ?? 999) - (rb?.sort_order ?? 999) ||
          a.localeCompare(b)
        )
      })
      .map(code => ({ value: code, label: byCode.get(code)?.label ?? code }))
  }, [currentLane, vialRolesQ.data])

  // Clear the sub-chip selection when switching lanes so a new lane never
  // starts with a stale (possibly foreign) active role filter.
  useEffect(() => {
    setSubRole('')
  }, [role])

  // Two-tier read-source: global default (admin setting) + per-user session
  // override, same mechanism as the samples list. 'mk1' serves the inbox
  // entirely from the local registry — no SENAITE round-trips.
  const { effective: readSource } = useEffectiveReadSource('worksheets_inbox')

  const {
    data: inboxData,
    isLoading,
    isError,
    error,
    refetch,
  } = useInboxSamples({
    hideTestOrders,
    hidePrepped,
    role,
    showXtra,
    source: readSource,
    // Gate on a VALIDATED role, not merely non-null: firing the inbox fetch
    // before the stored key is checked against the live lane set would 400
    // on a stale/deleted-department key.
    enabled: role !== null,
  })

  const handleForceRefresh = async () => {
    setIsRefreshing(true)
    try {
      await getInboxSamples({
        hideTestOrders,
        forceRefresh: true,
        hidePrepped,
        role,
        showXtra,
        source: readSource,
      })
      queryClient.invalidateQueries({ queryKey: ['inbox-samples'] })
    } finally {
      setIsRefreshing(false)
    }
  }

  const priorityMutation = usePriorityMutation()

  const { data: users = [] } = useQuery({
    queryKey: ['worksheet-users'],
    queryFn: getWorksheetUsers,
    staleTime: 5 * 60 * 1000,
  })

  const { data: worksheets = [], isLoading: worksheetsLoading } = useQuery({
    // Key aligned with the drawer/SampleDetails/list-page 'open' consumers
    // (2026-08-27) — the bare ['worksheets-list'] key was a separate cache
    // entry holding the same open-only data, defeating TanStack dedup.
    queryKey: ['worksheets-list', 'open'],
    queryFn: () => listWorksheets('open'),
    refetchInterval: 30_000,
  })

  const [activeDrag, setActiveDrag] = useState<
    DragData | FamilyDragData | null
  >(null)
  const [pendingDropKeys, setPendingDropKeys] = useState<Set<string>>(new Set())

  const vials = inboxData?.items ?? []

  // SLA column (2026-08-27): same indicator + breakdown tooltip as the Order
  // Status page, resolved through the shared subject hook. Subjects are built
  // over the FULL vial list (not the filtered view) so lane/filter switches
  // never refetch /sla/status. See inbox-sla.ts for the dept->group bridge.
  const { data: serviceGroups = [] } = useServiceGroups()
  const deptToGroup = useMemo(
    () => departmentToGroupId(serviceGroups),
    [serviceGroups]
  )
  const slaSubjects = useMemo(
    () => buildInboxSlaSubjects(inboxData?.items ?? [], deptToGroup),
    [inboxData, deptToGroup]
  )
  const {
    byKey: slaByKey,
    isLoading: slaLoading,
    isError: slaError,
  } = useSlaForSubjects(slaSubjects)
  const total = inboxData?.total ?? 0
  // role_tags carries the vial's own role plus rider profiles' roles from
  // custody edges; pre-1.8.5 payloads degrade to the bare role.
  const vialRoleTags = (v: InboxVialItem): string[] =>
    v.role_tags ?? (v.assignment_role ? [v.assignment_role] : [])
  // Everything EXCEPT the sub-chip filter — the sub-chip counts are faceted
  // over this list, so each chip's number is exactly what clicking it yields
  // under the currently-active text filters.
  const baseVisibleVials = vials
    // `${uid}::${departmentId}` — must stay byte-identical to InboxVialCard's
    // dragId and to the cardKey built from DragData below, or an optimistically
    // dropped card never hides (or never comes back on failure).
    .filter(
      v => !pendingDropKeys.has(`${v.uid}::${v.analyses[0]?.group_id ?? 0}`)
    )
    .filter(
      v => !sampleIdFilter.trim() || vialMatchesSampleId(v, sampleIdFilter)
    )
    .filter(
      v =>
        role !== 'hplc' ||
        !analyteFilter.trim() ||
        vialMatchesAnalyte(v, analyteFilter)
    )
  // Sub-chip role filter: a vial matches if the selected role's WORK is on it.
  const visibleVials = subRole
    ? baseVisibleVials.filter(v => vialRoleTags(v).includes(subRole))
    : baseVisibleVials
  // code -> vial count for the sub-chip badges ('' = the All chip).
  const subChipCounts = new Map<string, number>([
    ['', baseVisibleVials.length],
    ...laneSubChips.map(
      c =>
        [
          c.value,
          baseVisibleVials.filter(v => vialRoleTags(v).includes(c.value))
            .length,
        ] as [string, number]
    ),
  ])

  // Family-grouped rendering: groupInboxFamilies owns ALL ordering (family
  // rank = most urgent vial; vials by sequence). A family never splits
  // across the list — techs grab all of a sample's vials at once.
  const families = groupInboxFamilies(visibleVials)

  // Variance indicator: pull authoritative per-parent variance-sub flags so a
  // family reads as a variance job even when its variance vial is filtered out
  // of the current bench view. One batched call, mirroring the samples list.
  const parentIdsKey = Array.from(new Set(families.map(f => f.parentSampleId)))
    .sort()
    .join(',')
  const { data: aggregatesData } = useQuery({
    queryKey: ['inbox-aggregates', parentIdsKey],
    queryFn: () =>
      fetchSampleAggregates(parentIdsKey ? parentIdsKey.split(',') : []),
    enabled: parentIdsKey.length > 0,
    staleTime: 30_000,
  })
  const varianceParents = useMemo(
    () => varianceParentIds(aggregatesData?.aggregates ?? {}),
    [aggregatesData]
  )

  const filtersActive =
    sampleIdFilter.trim().length > 0 ||
    (role === 'hplc' && analyteFilter.trim().length > 0) ||
    subRole.length > 0
  const displayCount = filtersActive ? visibleVials.length : total

  function handlePriorityChange(sampleUid: string, priority: InboxPriority) {
    priorityMutation.mutate({ sampleUid, priority })
  }

  function clearFilters() {
    setSampleIdFilter('')
    setAnalyteFilter('')
    setSubRole('')
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveDrag(event.active.data.current as DragData | FamilyDragData)
    // Prevent body scroll during drag
    document.body.style.overflow = 'hidden'
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveDrag(null)
    document.body.style.overflow = ''
    const { over, active } = event
    if (!over) return

    const payload = active.data.current as DragData | FamilyDragData
    const dropId = String(over.id)

    if (payload && 'family' in payload) {
      await handleFamilyDrop(dropId, payload)
      return
    }

    const dragData = payload
    const cardKey = `${dragData.sampleUid}::${dragData.departmentId}`

    // Optimistically hide the card immediately
    setPendingDropKeys(prev => new Set(prev).add(cardKey))

    try {
      if (dropId === 'new-worksheet') {
        const result = await createWorksheetFromDrop({
          sample_uid: dragData.sampleUid,
          sample_id: dragData.sampleId,
          department_id: dragData.departmentId,
          date_received: dragData.dateReceived,
          analyses: dragData.analyses,
        })
        toast.success(`Created "${result.title}"`)
      } else if (dropId.startsWith('worksheet-')) {
        const worksheetId = Number(dropId.replace('worksheet-', ''))
        await addGroupToWorksheet(worksheetId, {
          sample_uid: dragData.sampleUid,
          sample_id: dragData.sampleId,
          department_id: dragData.departmentId,
          date_received: dragData.dateReceived,
          analyses: dragData.analyses,
        })
        toast.success(`Added to worksheet`)
      }
      // Refresh both inbox and worksheets list
      queryClient.invalidateQueries({ queryKey: ['inbox-samples'] })
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
    } catch (err) {
      // Restore card on failure
      setPendingDropKeys(prev => {
        const next = new Set(prev)
        next.delete(cardKey)
        return next
      })
      toast.error(
        err instanceof Error ? err.message : 'Failed to assign to worksheet'
      )
    }
  }

  async function handleFamilyDrop(dropId: string, fam: FamilyDragData) {
    const keys = fam.items.map(i => `${i.sampleUid}::${i.departmentId}`)
    setPendingDropKeys(prev => new Set([...prev, ...keys]))
    const failed: {
      sampleUid: string
      sampleId: string
      departmentId: number
    }[] = []
    let added = 0
    try {
      let worksheetId: number
      let createdTitle: string | null = null
      let queue = fam.items
      if (dropId === 'new-worksheet') {
        const [first, ...rest] = fam.items
        if (!first) return
        const result = await createWorksheetFromDrop({
          sample_uid: first.sampleUid,
          sample_id: first.sampleId,
          department_id: first.departmentId,
          date_received: first.dateReceived,
          analyses: first.analyses,
        })
        worksheetId = result.id
        createdTitle = result.title
        added += 1
        queue = rest
      } else if (dropId.startsWith('worksheet-')) {
        worksheetId = Number(dropId.replace('worksheet-', ''))
      } else {
        return
      }
      for (const item of queue) {
        try {
          await addGroupToWorksheet(worksheetId, {
            sample_uid: item.sampleUid,
            sample_id: item.sampleId,
            department_id: item.departmentId,
            date_received: item.dateReceived,
            analyses: item.analyses,
          })
          added += 1
        } catch {
          failed.push(item)
        }
      }
      if (added > 0) {
        toast.success(
          createdTitle
            ? `Created "${createdTitle}" with ${added} vial${added === 1 ? '' : 's'}`
            : `Added ${added} vial${added === 1 ? '' : 's'} to worksheet`
        )
      }
      if (failed.length > 0) {
        toast.error(
          `${failed.length} vial(s) not added: ${failed.map(f => f.sampleId).join(', ')}`
        )
      }
    } catch (err) {
      // Worksheet creation itself failed — restore every card
      failed.push(...fam.items)
      toast.error(
        err instanceof Error
          ? err.message
          : 'Failed to assign family to worksheet'
      )
    } finally {
      setPendingDropKeys(prev => {
        const next = new Set(prev)
        for (const f of failed) next.delete(`${f.sampleUid}::${f.departmentId}`)
        return next
      })
      queryClient.invalidateQueries({ queryKey: ['inbox-samples'] })
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
    }
  }

  // Lanes drive everything below (the chip row, the default role, the
  // empty-state copy) — a failed fetch must surface a retry, not a
  // permanently-loading page with no escape (spec 4, Task 10).
  if (lanesQ.isError) {
    return (
      <div className="h-[calc(100vh-4rem)] overflow-hidden p-6">
        <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-destructive/30 bg-destructive/5 py-12">
          <p className="text-sm text-destructive font-medium">
            {lanesQ.error instanceof Error
              ? lanesQ.error.message
              : 'Failed to load inbox lanes'}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => lanesQ.refetch()}
            className="gap-2"
          >
            <RefreshCw className="size-4" />
            Retry
          </Button>
        </div>
      </div>
    )
  }

  // While lanes are in flight, render a skeleton rather than the chip row +
  // grid flashing empty then popping in the real lane set.
  if (lanesQ.isLoading || role === null) {
    return (
      <div className="h-[calc(100vh-4rem)] overflow-hidden p-6">
        <CardSkeleton />
      </div>
    )
  }

  return (
    <div className="h-[calc(100vh-4rem)] overflow-hidden">
      <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="flex h-full overflow-hidden">
          {/* Left — inbox cards (scrollable) */}
          <div className="flex-1 overflow-y-auto">
            <div className="p-6">
              {/* Header */}
              <div className="flex items-start justify-between gap-4 mb-4">
                <div>
                  <div className="flex items-center gap-3">
                    <h1 className="text-2xl font-semibold tracking-tight">
                      Inbox
                    </h1>
                    {!isLoading && !isError && (
                      <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-sm font-medium text-muted-foreground">
                        {displayCount} vial{displayCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Drag vials to worksheets on the right
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <Checkbox
                      checked={hideTestOrders}
                      onCheckedChange={v => setHideTestOrders(v === true)}
                    />
                    <span className="text-sm text-muted-foreground">
                      Hide test orders
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <Checkbox
                      checked={hidePrepped}
                      onCheckedChange={v => setHidePrepped(v === true)}
                    />
                    <span className="text-sm text-muted-foreground">
                      Hide prepped
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <Checkbox
                      checked={showXtra}
                      onCheckedChange={v => setShowXtra(v === true)}
                    />
                    <span className="text-sm text-muted-foreground">
                      Show XTRA
                    </span>
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleForceRefresh}
                    disabled={isRefreshing}
                    className="gap-1.5 text-muted-foreground"
                    title="Force refresh from SENAITE (cached for 30 minutes)"
                  >
                    <RefreshCw
                      className={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
                    />
                    <span className="text-xs">Refresh</span>
                  </Button>
                  {/* Worksheets SOP — served from public/guides/ via Vite. Path
                    matches the file the build script mirrors there. */}
                  <a
                    href="/guides/lab-tech-worksheets-variance.html"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
                    title="Open the lab-tech worksheets &amp; variance SOP in a new tab"
                  >
                    <HelpCircle className="size-3.5" aria-hidden="true" />
                    Worksheets SOP
                  </a>
                </div>
              </div>

              {/* Bench filter chips — one per catalog-driven lane (spec 4, Task
                10). Label is the lane's department name (e.g. 'Analytical'
                for the legacy 'hplc' lane, not the 'HPLC' bench nickname) —
                a deliberate display delta, same convention as the Task 9
                AssignStep section headers; UAT punch item. */}
              <div
                className={cn(
                  'flex items-center gap-2',
                  role === 'microbiology' ? 'mb-3' : 'mb-6'
                )}
              >
                {lanes.map(lane => (
                  <button
                    key={lane.key}
                    type="button"
                    onClick={() => setStoredRole(lane.key)}
                    className={cn(
                      'inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium transition-colors',
                      role === lane.key
                        ? // Roles whose code exactly matches a badge palette
                          // entry (hplc, hm) get it; every other lane (including
                          // 'microbiology', which spans two role codes) falls
                          // back to the same neutral-violet active look
                          // Microbiology has always used.
                          laneBadgeClass(lane.key)
                        : 'bg-transparent text-muted-foreground border-border hover:bg-muted/40'
                    )}
                  >
                    {lane.label}
                  </button>
                ))}
              </div>

              {/* Lane sub-chips — one per role the active lane's department
                owns (catalog-driven; renders only for multi-role lanes).
                Filter by role_tags so rider work (e.g. fentanyl riding an
                hplc host vial) is reachable under its own chip. */}
              {laneSubChips.length > 0 && (
                <div className="mb-6 flex items-center gap-1.5 pl-4">
                  <span
                    className="text-muted-foreground/40 select-none"
                    aria-hidden="true"
                  >
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
                          ? // Active sub-chip carries its role's catalog colour;
                            // the "All" chip has no role, so laneBadgeClass falls
                            // back to neutral violet.
                            laneBadgeClass(c.value)
                          : 'bg-transparent text-muted-foreground border-border hover:bg-muted/40'
                      )}
                    >
                      {c.label}
                      {/* Faceted count: what clicking this chip yields under the
                        active text filters (worksheet-sidebar badge sibling). */}
                      <span className="tabular-nums text-[10px] opacity-60">
                        {subChipCounts.get(c.value) ?? 0}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {/* Client-side filters */}
              <div className="mb-6 flex flex-wrap items-center gap-2">
                <Input
                  placeholder="Sample ID"
                  value={sampleIdFilter}
                  onChange={e => setSampleIdFilter(e.target.value)}
                  className="h-8 w-40 text-sm"
                />
                {role === 'hplc' && (
                  <Input
                    placeholder="Analyte"
                    value={analyteFilter}
                    onChange={e => setAnalyteFilter(e.target.value)}
                    className="h-8 w-44 text-sm"
                  />
                )}
                {filtersActive && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  >
                    Clear
                  </button>
                )}
              </div>

              {/* Loading state */}
              {isLoading && <CardSkeleton />}

              {/* Error state */}
              {isError && (
                <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-destructive/30 bg-destructive/5 py-12">
                  <p className="text-sm text-destructive font-medium">
                    {error instanceof Error
                      ? error.message
                      : 'Failed to load received samples'}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refetch()}
                    className="gap-2"
                  >
                    <RefreshCw className="size-4" />
                    Retry
                  </Button>
                </div>
              )}

              {/* Empty state — copy is lane-LABEL driven (spec 4, Task 10), not
                a hardcoded HPLC/Microbiology pair. */}
              {!isLoading && !isError && visibleVials.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-3 rounded-md border py-16 text-center">
                  <Inbox className="size-12 text-muted-foreground/50" />
                  <p className="text-sm font-medium text-muted-foreground">
                    No {currentLane?.label ?? role} vials waiting
                  </p>
                  <p className="text-xs text-muted-foreground/60">
                    {(() => {
                      const otherLabels = lanes
                        .filter(l => l.key !== role)
                        .map(l => l.label)
                      return otherLabels.length > 0
                        ? `Switch to ${otherLabels.join(' or ')} to see those vials.`
                        : ''
                    })()}
                  </p>
                </div>
              )}

              {/* Cards — family-grouped. Vial-only families (container mode,
                no parent row) of 2+ get a draggable group section; legacy
                parent-led families keep the flat indent treatment. */}
              {!isLoading && !isError && visibleVials.length > 0 && (
                <div className="space-y-2">
                  {families.map(fam => {
                    const hasParentRow = fam.vials.some(v => v.is_parent)
                    if (fam.vials.length >= 2 && !hasParentRow) {
                      return (
                        <InboxFamilyGroup
                          key={fam.parentSampleId}
                          family={fam}
                          hasVarianceSubs={varianceParents.has(
                            fam.parentSampleId
                          )}
                          onPriorityChange={handlePriorityChange}
                          slaByKey={slaByKey}
                          slaLoading={slaLoading}
                          slaError={slaError}
                        />
                      )
                    }
                    const familyHasVariance = varianceParents.has(
                      fam.parentSampleId
                    )
                    return fam.vials.map((vial, idx) => (
                      <InboxVialCard
                        key={vial.uid}
                        vial={vial}
                        groupedWithPrevious={idx > 0}
                        parentHasVarianceSubs={familyHasVariance}
                        onPriorityChange={handlePriorityChange}
                        slaByKey={slaByKey}
                        slaLoading={slaLoading}
                        slaError={slaError}
                      />
                    ))
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right — worksheet drop panel (scrollable) */}
          <div className="w-96 shrink-0 h-full overflow-y-auto">
            <WorksheetDropPanel
              worksheets={worksheets}
              users={users}
              loading={worksheetsLoading}
              onRename={async (id, title) => {
                try {
                  await updateWorksheet(id, { title })
                  queryClient.invalidateQueries({
                    queryKey: ['worksheets-list'],
                  })
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : 'Rename failed'
                  )
                }
              }}
              onAssignTech={async (id, analystId) => {
                try {
                  await updateWorksheet(id, { assigned_analyst: analystId })
                  toast.success('Tech assigned to worksheet')
                  queryClient.invalidateQueries({
                    queryKey: ['worksheets-list'],
                  })
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : 'Assignment failed'
                  )
                }
              }}
              onDelete={async id => {
                try {
                  await deleteWorksheet(id)
                  toast.success('Worksheet deleted — items returned to inbox')
                  setPendingDropKeys(new Set())
                  queryClient.invalidateQueries({
                    queryKey: ['worksheets-list'],
                  })
                  queryClient.invalidateQueries({ queryKey: ['inbox-samples'] })
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : 'Delete failed'
                  )
                }
              }}
              onRemoveItem={async (worksheetId, itemId) => {
                try {
                  await removeWorksheetItem(worksheetId, itemId)
                  toast.success('Item returned to inbox')
                  setPendingDropKeys(new Set())
                  queryClient.invalidateQueries({
                    queryKey: ['worksheets-list'],
                  })
                  queryClient.invalidateQueries({ queryKey: ['inbox-samples'] })
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : 'Remove failed'
                  )
                }
              }}
            />
          </div>
        </div>

        {/* Drag overlay — shows a ghost card while dragging */}
        <DragOverlay dropAnimation={null}>
          {activeDrag &&
            ('family' in activeDrag ? (
              <div className="rounded-lg border bg-card shadow-xl px-3 py-2 opacity-90 w-56 pointer-events-none">
                <span className="font-mono text-xs font-semibold">
                  {activeDrag.parentSampleId}
                </span>
                <span className="mx-1.5 text-muted-foreground/50">·</span>
                <span className="text-xs">{activeDrag.items.length} vials</span>
              </div>
            ) : (
              <div className="rounded-lg border bg-card shadow-xl px-3 py-2 opacity-90 w-48 pointer-events-none">
                <span className="font-mono text-xs font-medium">
                  {activeDrag.sampleId}
                </span>
                <span className="mx-1.5 text-muted-foreground/50">·</span>
                <span className="text-xs">{activeDrag.groupName}</span>
              </div>
            ))}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
