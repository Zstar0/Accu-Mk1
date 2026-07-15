import { useState, useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  XCircle,
  AlertCircle,
  Clock,
  LayoutList,
  Columns3,
  Layers,
  ArrowUpDown,
  ListTree,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  getExplorerStatus,
  getExplorerOrders,
  clearSenaiteLookupCache,
  type ExplorerOrder,
  type SenaiteLookupResult,
  type SenaiteAnalysis,
} from '@/lib/api'
import {
  getActiveEnvironmentName,
  getWordpressUrl,
  API_PROFILE_CHANGED_EVENT,
} from '@/lib/api-profiles'
import { useUIStore } from '@/store/ui-store'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  formatProcessingTime,
  getOrderEmail,
  groupAnalysisStates,
  HighlightMatch,
  sampleMatchesAnalysisFilter,
  COL_COUNT_LABEL,
  TEST_EMAILS,
  type AnalysisStateCounts,
} from '@/components/explorer/helpers'
import { toggleFilterKey, isOrderAtRisk, orderMatchesLot } from '@/components/explorer/order-filters'
import { OrderRow } from '@/components/explorer/OrderRow'
import { FlagIndicator } from '@/components/flags/FlagIndicator'
import { SampleSlaIndicator } from '@/components/explorer/SampleSlaIndicator'
import { useOrderSlaStatuses, type SampleSlaSnapshot } from '@/services/order-sla'
import { useSenaiteLookupMap } from '@/services/senaite-lookup-map'
import { useEffectiveReadSource } from '@/lib/read-source'

// Re-export TEST_EMAILS so the existing import surface
// `import { TEST_EMAILS } from '@/components/OrderStatusPage'` keeps working
// (Plan 29-00 CONTEXT D-03).
export { TEST_EMAILS } from '@/components/explorer/helpers'

// --- Relative time formatter ---
function formatRelativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

// --- Kanban types & components ---

type KanbanCol = { key: string; label: string; countKey: keyof AnalysisStateCounts }

const KANBAN_COLUMNS: KanbanCol[] = [
  { key: 'sample_due', label: 'Sample Due', countKey: 'sample_due' },
  { key: 'received', label: 'Received', countKey: 'received' },
  { key: 'assigned', label: 'Assigned', countKey: 'assigned' },
  { key: 'to_verify', label: 'To Verify', countKey: 'to_verify' },
  { key: 'waiting_for_addon', label: 'Waiting Addon', countKey: 'waiting_for_addon' },
  { key: 'ready_for_review', label: 'Ready for Review', countKey: 'ready_for_review' },
  { key: 'verified', label: 'Verified', countKey: 'verified' },
  { key: 'published', label: 'Published', countKey: 'published' },
]

interface KanbanSampleItem {
  sampleId: string
  orderId: string | number
  email: string | null
  createdAt: string
  completedAt: string | null
  colKey: string
  count: number
  lookup: SenaiteLookupResult | undefined
  isLoading: boolean
  isError: boolean
  analysisServices?: string[]  // names of analyses matching this column's state
  lot?: string  // payload lot_code, positionally aligned (display fallback for client_lot)
}

// Tailwind classes for count pill background per column
const COL_PILL_CLASS: Record<string, string> = {
  sample_due: 'bg-yellow-500/15 text-yellow-400',
  received: 'bg-cyan-500/15 text-cyan-400',
  assigned: 'bg-blue-500/15 text-blue-400',
  to_verify: 'bg-amber-500/15 text-amber-400',
  waiting_for_addon: 'bg-indigo-500/15 text-indigo-400',
  ready_for_review: 'bg-teal-500/15 text-teal-400',
  verified: 'bg-green-500/15 text-green-500',
  published: 'bg-purple-500/15 text-purple-400',
}

// Map column key → analysis review_states that belong in that column
const COL_ANALYSIS_STATES: Record<string, string[]> = {
  assigned: ['assigned'],
  to_verify: ['to_be_verified'],
  verified: ['verified'],
  published: ['published'],
}

const COMPLETED_ANALYSIS_STATES = new Set(['verified', 'published', 'rejected', 'cancelled', 'invalid', 'retracted'])

function buildAnalyteNameMap(lookup: SenaiteLookupResult | undefined): Map<number, string> {
  const map = new Map<number, string>()
  if (!lookup?.analytes) return map
  for (const analyte of lookup.analytes) {
    const displayName = analyte.matched_peptide_name ?? analyte.raw_name.replace(/\s*-\s*[^-]+\([^)]+\)\s*$/, '')
    map.set(analyte.slot_number, displayName)
  }
  return map
}

function formatAnalysisTitle(title: string, nameMap: Map<number, string>): string {
  const match = title.match(/^Analyte\s+(\d)\s*(.*)/i)
  if (match?.[1]) {
    const slot = parseInt(match[1], 10)
    const suffix = match[2] ?? ''
    const peptideName = nameMap.get(slot)
    if (peptideName) return `${peptideName} ${suffix}`.trim()
  }
  return title
}

function getAnalysisServicesForCol(analyses: SenaiteAnalysis[], colKey: string, lookup?: SenaiteLookupResult): string[] {
  const nameMap = buildAnalyteNameMap(lookup)
  const format = (a: SenaiteAnalysis) => formatAnalysisTitle(a.title, nameMap)

  // For waiting_for_addon and ready_for_review: show analyses that are NOT completed (the outstanding ones)
  if (colKey === 'waiting_for_addon' || colKey === 'ready_for_review') {
    return analyses
      .filter(a => !COMPLETED_ANALYSIS_STATES.has(a.review_state?.toLowerCase() ?? ''))
      .map(format)
  }
  const states = COL_ANALYSIS_STATES[colKey]
  if (!states) return []
  return analyses
    .filter(a => states.includes(a.review_state?.toLowerCase() ?? ''))
    .map(format)
}

// Plain text label for SENAITE sample state — avoids badge confusion with column state
function sampleStateLabel(state: string | null): string {
  const s = state?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    received: 'Received',
    sample_received: 'Received',
    to_be_verified: 'To be verified',
    verified: 'Verified',
    published: 'Published',
    sample_due: 'Sample Due',
    waiting_for_addon_results: 'Waiting Addon',
    ready_for_review: 'Ready for Review',
    registered: 'Registered',
    sample_registered: 'Registered',
    invalid: 'Invalid',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
  }
  return map[s] ?? (state ?? 'Unknown')
}

function KanbanSampleCard({
  item,
  showOrder,
  showAnalysisServices,
  lotHighlight,
  sampleSlaStatusesMap,
}: {
  item: KanbanSampleItem
  showOrder: boolean
  showAnalysisServices: boolean
  // Active Lot-filter query — matched substrings inside the displayed lot
  // value get a browser-find-style <mark> highlight (presentational only).
  lotHighlight?: string
  // Multi-tier follow-on: each sample now has an array of snapshots (one per
  // service group). Until the indicator itself renders stacked rows, we pick
  // the first element so behavior stays single-tier-visible.
  sampleSlaStatusesMap?: Map<string, SampleSlaSnapshot[]>
}) {
  const navigateToSample = useUIStore(state => state.navigateToSample)
  const navigateToOrderExplorer = useUIStore(state => state.navigateToOrderExplorer)

  if (item.isLoading) {
    return (
      <div className="rounded border border-border/50 bg-muted/20 px-2 py-1 flex items-center gap-1.5 text-muted-foreground">
        <RefreshCw className="h-2.5 w-2.5 animate-spin shrink-0" />
        <span className="font-mono text-[11px]">{item.sampleId}</span>
      </div>
    )
  }

  const pillClass = COL_PILL_CLASS[item.colKey] ?? 'bg-muted/60 text-muted-foreground'
  const countLabel = COL_COUNT_LABEL[item.colKey] ?? ''

  // Unique analysts assigned to analyses in this column
  const analysts = (() => {
    if (!item.lookup) return []
    const colStates = COL_ANALYSIS_STATES[item.colKey]
    const relevant = colStates
      ? item.lookup.analyses.filter(a => colStates.includes(a.review_state?.toLowerCase() ?? ''))
      : item.colKey === 'waiting_for_addon' || item.colKey === 'ready_for_review'
      ? item.lookup.analyses.filter(a => !COMPLETED_ANALYSIS_STATES.has(a.review_state?.toLowerCase() ?? ''))
      : []
    const names = new Set(relevant.map(a => a.analyst).filter((n): n is string => !!n))
    return Array.from(names)
  })()

  const kanbanLot = item.lookup?.client_lot?.trim() || item.lot

  return (
    <div className="rounded border border-border/50 bg-card px-2 py-1 hover:border-border transition-colors cursor-pointer">
      {/* Row 1: sample ID + email (left) + count pill (right) */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            className="text-[11px] font-mono font-semibold text-primary hover:underline leading-none cursor-pointer shrink-0"
            onClick={() => navigateToSample(item.sampleId)}
          >
            {item.sampleId}
          </button>
          <FlagIndicator scope={{ kind: 'sample', sampleId: item.sampleId }} />
          {item.email && (
            <span className="text-[10px] text-muted-foreground/60 leading-none truncate">{item.email}</span>
          )}
        </div>
        {/* Count pill: "17 to verify" — makes the number self-explanatory */}
        <span className={cn('inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none shrink-0', pillClass)}>
          {item.count}
          <span className="font-normal opacity-80">{countLabel}</span>
        </span>
      </div>
      {/* Analysts */}
      {analysts.length > 0 && (
        <div className="flex items-center gap-1 mt-0.5">
          <span className="text-[10px] text-muted-foreground/50">Tech:</span>
          <span className="text-[10px] text-muted-foreground/80 truncate">
            {analysts.join(', ')}
          </span>
        </div>
      )}
      {kanbanLot && (
        <div className="flex items-center gap-1 mt-0.5">
          <span className="text-[10px] text-muted-foreground/50">Lot:</span>
          <span className="text-[10px] text-muted-foreground/80 truncate">
            <HighlightMatch text={kanbanLot} query={lotHighlight} />
          </span>
        </div>
      )}
      {/* Row 2: secondary metadata — clearly separated from analysis state */}
      {(showOrder || item.lookup) && (
        <div className="flex items-center justify-between gap-1 mt-0.5">
          <div className="flex items-center gap-1">
            {showOrder && (
              <button
                type="button"
                className="text-[10px] text-muted-foreground/50 font-mono leading-none hover:text-primary hover:underline cursor-pointer transition-colors"
                onClick={() => navigateToOrderExplorer(String(item.orderId))}
              >
                #{item.orderId}
              </button>
            )}
            {item.lookup && (
              <>
                {showOrder && <span className="text-muted-foreground/30 text-[10px]">·</span>}
                <span className="text-[10px] text-muted-foreground/50 leading-none">
                  Sample: {sampleStateLabel(item.lookup.review_state)}
                </span>
              </>
            )}
          </div>
          {!(item.lookup?.date_received && item.lookup.review_state !== 'published') && (
            <span className={cn(
              'text-[10px] font-mono leading-none tabular-nums',
              item.completedAt ? 'text-green-600/70' : 'text-amber-500/70'
            )}>
              {formatProcessingTime(item.createdAt, item.completedAt)}
            </span>
          )}
        </div>
      )}
      {item.lookup?.date_received && item.lookup.review_state !== 'published' && (
        <div className="mt-0.5">
          <SampleSlaIndicator snapshots={sampleSlaStatusesMap?.get(item.sampleId)} />
        </div>
      )}
      {showAnalysisServices && item.colKey !== 'published' && item.analysisServices && item.analysisServices.length > 0 && (
        <div className="mt-1 pt-1 border-t border-border/30">
          {item.analysisServices.map((name, i) => (
            <div key={i} className="text-[10px] text-muted-foreground/70 leading-relaxed truncate">
              {name}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function KanbanView({
  orders,
  sampleLookupMap,
  groupByOrder,
  activeStates,
  showAnalysisServices,
  lotHighlight,
  sampleSlaStatusesMap,
  collapsedCols,
  onToggleCollapse,
}: {
  orders: ExplorerOrder[]
  sampleLookupMap: Map<string, { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }>
  groupByOrder: boolean
  activeStates: string[]
  showAnalysisServices: boolean
  // Active Lot-filter query, forwarded to every KanbanSampleCard for
  // browser-find-style highlighting of the matched lot substring.
  lotHighlight?: string
  sampleSlaStatusesMap?: Map<string, SampleSlaSnapshot[]>
  collapsedCols: string[]
  onToggleCollapse: (key: string) => void
}) {
  // Determine which columns to show — all if no filter, else just the active one
  const visibleCols = activeStates.length > 0
    ? KANBAN_COLUMNS.filter(c => activeStates.includes(c.key))
    : KANBAN_COLUMNS

  // Build all kanban items: one item per (sample, col) where count > 0
  const allItems = useMemo(() => {
    const items: KanbanSampleItem[] = []
    for (const order of orders) {
      if (!order.sample_results) continue
      const email = getOrderEmail(order)
      const kanbanPayloadSamples = (
        order.payload as { samples?: { lot_code?: string }[] } | null | undefined
      )?.samples
      for (const [slotKey, entry] of Object.entries(order.sample_results)) {
        if (!entry.senaite_id || entry.status === 'failed') continue
        const slotIdx = parseInt(slotKey, 10) - 1
        const rawLot = Number.isNaN(slotIdx)
          ? undefined
          : kanbanPayloadSamples?.[slotIdx]?.lot_code
        const lot =
          rawLot && rawLot.trim().length > 0 ? rawLot.trim() : undefined
        const lq = sampleLookupMap.get(entry.senaite_id)
        if (lq?.isLoading) {
          for (const col of visibleCols) {
            items.push({
              sampleId: entry.senaite_id,
              orderId: order.order_id,
              email,
              createdAt: order.created_at,
              completedAt: order.completed_at,
              colKey: col.key,
              count: 0,
              lookup: undefined,
              isLoading: true,
              isError: false,
              lot,
            })
          }
          continue
        }
        if (!lq?.data) continue
        const counts = groupAnalysisStates(lq.data.analyses, lq.data.review_state)
        for (const col of visibleCols) {
          const count = counts[col.countKey]
          if (count > 0) {
            items.push({
              sampleId: entry.senaite_id,
              orderId: order.order_id,
              email,
              createdAt: order.created_at,
              completedAt: order.completed_at,
              colKey: col.key,
              count,
              lookup: lq.data,
              isLoading: false,
              isError: false,
              analysisServices: getAnalysisServicesForCol(lq.data.analyses, col.key, lq.data),
              lot,
            })
          }
        }
      }
    }
    return items
  }, [orders, sampleLookupMap, visibleCols])

  if (!groupByOrder) {
    // Flat Kanban — just columns of sample cards
    return (
      <div
        className="grid gap-3 min-w-0"
        style={{
          gridTemplateColumns: visibleCols
            .map(c => (collapsedCols.includes(c.key) ? 'minmax(40px, auto)' : 'minmax(180px, 1fr)'))
            .join(' '),
        }}
      >
        {visibleCols.map(col => {
          const colItems = allItems.filter(i => i.colKey === col.key)
          const collapsed = collapsedCols.includes(col.key)
          return (
            <div key={col.key} className="flex flex-col gap-2 min-w-0">
              <button
                type="button"
                onClick={() => onToggleCollapse(col.key)}
                title={collapsed ? `Expand ${col.label}` : `Collapse ${col.label}`}
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
                  {colItems.filter(i => !i.isLoading).length}
                </Badge>
              </button>
              {!collapsed && (
                <div className="flex flex-col gap-1">
                  {colItems.length === 0 && (
                    <div className="text-xs text-muted-foreground/50 text-center py-4">Empty</div>
                  )}
                  {colItems.map(item => (
                    <KanbanSampleCard
                      key={`${item.sampleId}-${item.colKey}`}
                      item={item}
                      showOrder={true}
                      showAnalysisServices={showAnalysisServices}
                      lotHighlight={lotHighlight}
                      sampleSlaStatusesMap={sampleSlaStatusesMap}
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

  // Grouped by order — swimlane per order
  return (
    <div className="flex flex-col gap-4">
      {orders.map(order => {
        const orderItems = allItems.filter(i => i.orderId === order.order_id)
        if (orderItems.length === 0 && activeStates.length > 0) return null
        const email = getOrderEmail(order)

        return (
          <div key={order.id} className="rounded-lg border border-border/50 overflow-hidden">
            {/* Swimlane header */}
            <div className="flex items-center gap-3 px-3 py-2 bg-muted/30 border-b border-border/50">
              <a
                href={`${window.location.href.split('#')[0]}`}
                className="font-mono text-sm font-semibold text-primary hover:underline"
              >
                #{order.order_id}
              </a>
              <FlagIndicator
                scope={{
                  kind: 'order',
                  orderId: order.order_id,
                  sampleIds: Object.values(order.sample_results ?? {})
                    .filter(s => s.status !== 'failed' && s.senaite_id)
                    .map(s => s.senaite_id),
                  label: `#${order.order_number}`,
                }}
                variant="pill"
              />
              {email && <span className="text-xs text-muted-foreground">{email}</span>}
              <span className="text-xs text-muted-foreground ml-auto">
                {order.samples_delivered}/{order.samples_expected} samples · {formatProcessingTime(order.created_at, order.completed_at)}
              </span>
            </div>

            {/* Columns grid */}
            <div
              className="grid gap-0 divide-x divide-border/30"
              style={{ gridTemplateColumns: `repeat(${visibleCols.length}, 1fr)` }}
            >
              {visibleCols.map(col => {
                const colItems = orderItems.filter(i => i.colKey === col.key)
                return (
                  <div key={col.key} className="p-1.5 flex flex-col gap-1 min-w-[150px]">
                    {colItems.length === 0 ? (
                      <div className="text-xs text-muted-foreground/30 text-center py-2">—</div>
                    ) : (
                      colItems.map(item => (
                        <KanbanSampleCard
                          key={`${item.sampleId}-${item.colKey}`}
                          item={item}
                          showOrder={false}
                          showAnalysisServices={showAnalysisServices}
                          lotHighlight={lotHighlight}
                          sampleSlaStatusesMap={sampleSlaStatusesMap}
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

// --- Sample state filter config ---

const ANALYSIS_STATE_BUTTONS = [
  { key: 'sample_due', label: 'Sample Due', tooltip: 'Sample expected but not yet received in the lab (being mailed in)' },
  { key: 'received', label: 'Received', tooltip: 'Sample physically received in the lab and ready for analysis' },
  { key: 'assigned', label: 'Assigned', tooltip: 'Analyses assigned to a lab tech via a SENAITE worksheet' },
  { key: 'to_verify', label: 'To Verify', tooltip: 'Tech has submitted results, waiting for supervisor verification' },
  { key: 'waiting_for_addon', label: 'Waiting Addon', tooltip: 'Initial analyses verified, waiting for outsourced/addon test results to come back' },
  { key: 'ready_for_review', label: 'Ready for Review', tooltip: 'Addon results are back and entered, sample ready for final review before verification' },
  { key: 'verified', label: 'Verified', tooltip: 'All results reviewed and approved by a supervisor' },
  { key: 'published', label: 'Published', tooltip: 'Results finalized and published, COA available' },
] as const

// --- localStorage filter state ---

const FILTERS_LS_KEY = 'order-status-filters'

interface OrderFilters {
  activeStates: string[]
  sampleIdFilter: string
  emailFilter: string
  orderIdFilter: string
  analyteFilter: string
  lotFilter: string
  hideTestOrders: boolean
  slaAtRisk: boolean
  collapsedKanbanCols: string[]
  viewMode: 'table' | 'kanban'
  groupByOrder: boolean
  showAnalysisServices: boolean
  kanbanSort: 'order_id' | 'processing_time'
  kanbanSortDir: 'asc' | 'desc'
}

function loadOrderFilters(): OrderFilters {
  try {
    const raw = localStorage.getItem(FILTERS_LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as OrderFilters
      return {
        ...parsed,
        activeStates: (parsed.activeStates ?? []).filter(s => s !== 'pending'),
        collapsedKanbanCols: parsed.collapsedKanbanCols ?? [],
        analyteFilter: parsed.analyteFilter ?? '',
        lotFilter: parsed.lotFilter ?? '',
      }
    }
  } catch {
    // ignore parse errors
  }
  return {
    activeStates: [],
    sampleIdFilter: '',
    emailFilter: '',
    orderIdFilter: '',
    analyteFilter: '',
    lotFilter: '',
    hideTestOrders: true,
    slaAtRisk: false,
    collapsedKanbanCols: [],
    viewMode: 'table',
    groupByOrder: true,
    showAnalysisServices: false,
    kanbanSort: 'processing_time',
    kanbanSortDir: 'desc',
  }
}

function saveOrderFilters(f: OrderFilters) {
  try {
    localStorage.setItem(FILTERS_LS_KEY, JSON.stringify(f))
  } catch {
    // ignore quota errors
  }
}

// --- Main component ---

export function OrderStatusPage() {
  const [showAll, setShowAll] = useState(false)
  const [envName, setEnvName] = useState(() => getActiveEnvironmentName())
  const [orderFilters, setOrderFilters] = useState<OrderFilters>(loadOrderFilters)

  const updateFilters = (partial: Partial<OrderFilters>) => {
    setOrderFilters(prev => {
      const next = { ...prev, ...partial }
      saveOrderFilters(next)
      return next
    })
  }

  const toggleState = (key: string) => {
    updateFilters({
      activeStates: toggleFilterKey(orderFilters.activeStates, key),
    })
  }

  const toggleCollapsedCol = (key: string) => {
    updateFilters({
      collapsedKanbanCols: toggleFilterKey(orderFilters.collapsedKanbanCols, key),
    })
  }
  const wordpressHost = getWordpressUrl()
  const queryClient = useQueryClient()

  useEffect(() => {
    const handleProfileChange = () => setEnvName(getActiveEnvironmentName())
    window.addEventListener(API_PROFILE_CHANGED_EVENT, handleProfileChange)
    return () =>
      window.removeEventListener(API_PROFILE_CHANGED_EVENT, handleProfileChange)
  }, [])

  // Connection status
  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['explorer', 'status', envName],
    queryFn: getExplorerStatus,
    staleTime: 0,
  })

  // Fetch orders (all, then filter client-side)
  const {
    data: allOrders,
    isLoading: ordersLoading,
    error: ordersError,
  } = useQuery({
    queryKey: ['explorer', 'orders', '', 'all', 0, envName],
    queryFn: () => getExplorerOrders(undefined, 200, 0),
    enabled: status?.connected === true,
    staleTime: 30_000,
  })

  // Filter to open orders or show all, and optionally hide test orders + text filters
  const orders = useMemo(() => {
    if (!allOrders) return []
    let filtered = showAll ? allOrders : allOrders.filter(o => o.wp_order_status !== 'complete')
    if (orderFilters.hideTestOrders) {
      filtered = filtered.filter(o => {
        const email = getOrderEmail(o)?.toLowerCase()
        return !email || !TEST_EMAILS.includes(email)
      })
    }
    const { orderIdFilter, emailFilter, sampleIdFilter } = orderFilters
    if (orderIdFilter.trim()) {
      const q = orderIdFilter.trim().toLowerCase()
      filtered = filtered.filter(o => String(o.order_id).toLowerCase().includes(q))
    }
    if (emailFilter.trim()) {
      const q = emailFilter.trim().toLowerCase()
      filtered = filtered.filter(o => (getOrderEmail(o)?.toLowerCase() ?? '').includes(q))
    }
    if (sampleIdFilter.trim()) {
      const q = sampleIdFilter.trim().toLowerCase()
      filtered = filtered.filter(o => {
        if (!o.sample_results) return false
        return Object.values(o.sample_results).some(v => v.senaite_id?.toLowerCase().includes(q))
      })
    }
    return filtered
  }, [allOrders, showAll, orderFilters])

  // Per-sample SENAITE lookup map (shared hook — see useSenaiteLookupMap).
  // `sampleLookupMap` is consumed below by the analysis-state filter
  // (filteredOrders) and by useOrderSlaStatuses; built from the full `orders`
  // set so filtered lookups are always present. Resolved from the
  // 'sample_details' two-tier read-source setting — same mechanism as
  // SampleDetails.tsx; defaults to 'senaite' (no behavior change until the
  // Handler flips it).
  const { effective: sampleDetailsSource } = useEffectiveReadSource('sample_details')
  const { sampleLookupMap, isFetching: sampleLookupFetching, lastCachedAt } =
    useSenaiteLookupMap(orders, sampleDetailsSource)

  // Hide orders where no samples match the active analysis state filter
  const filteredOrders = useMemo(() => {
    let result = orders
    if (orderFilters.activeStates.length > 0) {
      result = result.filter(o => {
        if (!o.sample_results) return false
        return Object.values(o.sample_results).some(v =>
          v.senaite_id && sampleMatchesAnalysisFilter(v.senaite_id, orderFilters.activeStates, sampleLookupMap)
        )
      })
    }
    // Analyte filter — match the analysis names shown on the cards
    // (formatAnalysisTitle) against the query, case-insensitive substring. Only
    // loaded sample lookups can match; results refine as SENAITE lookups arrive.
    const analyteQ = orderFilters.analyteFilter.trim().toLowerCase()
    if (analyteQ) {
      result = result.filter(o => {
        if (!o.sample_results) return false
        return Object.values(o.sample_results).some(v => {
          if (!v.senaite_id) return false
          const lookup = sampleLookupMap.get(v.senaite_id)?.data
          if (!lookup) return false
          const nameMap = buildAnalyteNameMap(lookup)
          return lookup.analyses.some(a =>
            formatAnalysisTitle(a.title, nameMap).toLowerCase().includes(analyteQ)
          )
        })
      })
    }
    // Lot filter — payload lot_code (instant) OR loaded SENAITE client_lot
    // (refines as lookups arrive). Same progressive-refinement contract as
    // the analyte filter above.
    const lotQ = orderFilters.lotFilter.trim().toLowerCase()
    if (lotQ) {
      result = result.filter(o => orderMatchesLot(o, lotQ, sampleLookupMap))
    }
    // Apply kanban sort when in grouped kanban mode
    if (orderFilters.viewMode === 'kanban') {
      const dir = orderFilters.kanbanSortDir === 'asc' ? 1 : -1
      result = [...result].sort((a, b) => {
        if (orderFilters.kanbanSort === 'order_id') {
          return dir * a.order_id.localeCompare(b.order_id, undefined, { numeric: true })
        }
        // processing_time: sort by created_at (oldest = longest outstanding)
        return dir * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      })
    }
    return result
  }, [orders, orderFilters, sampleLookupMap])

  // D2: order-aggregated SLA verdicts + per-sample status snapshots for the
  // table-view SLA column and the card-view SampleSlaIndicator. The hook is
  // useMemo-aggregated; only its one /sla/status batch query re-runs on data
  // changes (sharpenings #3, #4).
  const orderSla = useOrderSlaStatuses(filteredOrders, sampleLookupMap)

  // Count of at-risk orders in the current filtered set — drives the toggle's
  // badge regardless of whether the toggle is on.
  const atRiskCount = useMemo(
    () =>
      filteredOrders.filter(o =>
        isOrderAtRisk(orderSla.verdictByOrderId.get(o.order_id))
      ).length,
    [filteredOrders, orderSla.verdictByOrderId]
  )

  // When the SLA toggle is on, narrow to orders approaching/over their target.
  // Computed AFTER orderSla (which runs on the full filteredOrders), so verdicts
  // for the narrowed subset are always present. Loading-SLA orders are excluded
  // while the toggle is on (only known-at-risk shown).
  const displayedOrders = useMemo(
    () =>
      orderFilters.slaAtRisk
        ? filteredOrders.filter(o =>
            isOrderAtRisk(orderSla.verdictByOrderId.get(o.order_id))
          )
        : filteredOrders,
    [filteredOrders, orderFilters.slaAtRisk, orderSla.verdictByOrderId]
  )

  // Count orders needing attention (have samples with to_verify analyses)
  const attentionCount = useMemo(() => {
    let count = 0
    for (const order of orders) {
      if (!order.sample_results) continue
      for (const entry of Object.values(order.sample_results)) {
        const lookup = sampleLookupMap.get(entry.senaite_id)
        if (lookup?.data) {
          const counts = groupAnalysisStates(lookup.data.analyses, lookup.data.review_state)
          if (counts.to_verify > 0) {
            count++
            break
          }
        }
      }
    }
    return count
  }, [orders, sampleLookupMap])

  // Aggregate sample counts per filter state (for badge display on filter buttons)
  const filterCounts = useMemo(() => {
    const totals: Record<string, number> = {}
    for (const order of orders) {
      if (!order.sample_results) continue
      for (const entry of Object.values(order.sample_results)) {
        const lookup = sampleLookupMap.get(entry.senaite_id)
        if (!lookup?.data) continue
        const counts = groupAnalysisStates(lookup.data.analyses, lookup.data.review_state)
        for (const key of Object.keys(counts) as (keyof AnalysisStateCounts)[]) {
          if (counts[key] > 0) totals[key] = (totals[key] ?? 0) + 1
        }
      }
    }
    return totals
  }, [orders, sampleLookupMap])

  const lastUpdated = lastCachedAt

  const openCount = useMemo(() => {
    if (!allOrders) return 0
    let filtered = allOrders.filter(o => o.wp_order_status !== 'complete')
    if (orderFilters.hideTestOrders) {
      filtered = filtered.filter(o => {
        const email = getOrderEmail(o)?.toLowerCase()
        return !email || !TEST_EMAILS.includes(email)
      })
    }
    return filtered.length
  }, [allOrders, orderFilters])

  // True while any senaite lookup is actively fetching
  const isRefreshing = sampleLookupFetching

  const handleRefresh = async () => {
    // Clear server-side cache, then invalidate all client queries
    await clearSenaiteLookupCache().catch(Function.prototype as () => void)
    queryClient.invalidateQueries({ queryKey: ['explorer'] })
    queryClient.removeQueries({ queryKey: ['senaite', 'lookup'] })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Activity className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-semibold">Order Status</h2>
            <p className="text-sm text-muted-foreground">
              At-a-glance view of order and sample states
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Badge variant="outline" className="text-xs">
            {envName}
          </Badge>

          {lastUpdated && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground" title={new Date(lastUpdated).toLocaleString()}>
              <Clock className="h-3 w-3" />
              Updated {formatRelativeTime(lastUpdated)}
            </span>
          )}

          <Button
            variant="outline"
            size="icon"
            onClick={handleRefresh}
            disabled={statusLoading || isRefreshing}
            title="Refresh all data"
          >
            <RefreshCw
              className={cn(
                'h-4 w-4',
                (isRefreshing || ordersLoading) && 'animate-spin'
              )}
            />
          </Button>

          {statusLoading && (
            <Badge variant="secondary">
              <RefreshCw className="h-3 w-3 animate-spin mr-1" />
              Connecting...
            </Badge>
          )}
          {status?.connected && !statusLoading && (
            <Badge variant="default" className="bg-green-600">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          )}
          {status && !status.connected && !statusLoading && (
            <Badge variant="destructive">
              <XCircle className="h-3 w-3 mr-1" />
              Disconnected
            </Badge>
          )}
        </div>
      </div>

      {/* Connection error */}
      {status && !status.connected && (
        <Card className="border-destructive">
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span>Failed to connect to database: {status.error}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filter controls */}
      {status?.connected && (
        <div className="flex flex-col gap-2">
          {/* Row 1: Open/All + hide test + view toggle + attention */}
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              variant={showAll ? 'outline' : 'default'}
              size="sm"
              onClick={() => setShowAll(false)}
            >
              Open Orders
              {!ordersLoading && (
                <Badge variant="secondary" className="ml-1.5">
                  {openCount}
                </Badge>
              )}
            </Button>
            <Button
              variant={showAll ? 'default' : 'outline'}
              size="sm"
              onClick={() => setShowAll(true)}
            >
              All Orders
              {!ordersLoading && allOrders && (
                <Badge variant="secondary" className="ml-1.5">
                  {allOrders.length}
                </Badge>
              )}
            </Button>
            <Button
              variant={orderFilters.slaAtRisk ? 'default' : 'outline'}
              size="sm"
              onClick={() => updateFilters({ slaAtRisk: !orderFilters.slaAtRisk })}
              title="Show only orders approaching or past their SLA target"
              className={cn(
                orderFilters.slaAtRisk &&
                  'bg-amber-500 text-white border-amber-500 hover:bg-amber-600'
              )}
            >
              ⚠ SLA at-risk
              {!ordersLoading && atRiskCount > 0 && (
                <Badge variant="secondary" className="ml-1.5">
                  {atRiskCount}
                </Badge>
              )}
            </Button>

            <label className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap cursor-pointer ml-1">
              <Checkbox
                checked={orderFilters.hideTestOrders}
                onCheckedChange={checked => updateFilters({ hideTestOrders: checked === true })}
              />
              Hide test orders
            </label>

            {/* View toggle */}
            <div className="flex items-center gap-1 ml-auto">
              {orderFilters.viewMode === 'kanban' && (
                <>
                  <button
                    type="button"
                    title="Group by order"
                    onClick={() => updateFilters({ groupByOrder: !orderFilters.groupByOrder })}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition-colors',
                      orderFilters.groupByOrder
                        ? 'bg-foreground text-background border-foreground'
                        : 'bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'
                    )}
                  >
                    <Layers className="h-3.5 w-3.5" />
                    By Order
                  </button>
                  <button
                    type="button"
                    title="Show analysis services in each card"
                    onClick={() => updateFilters({ showAnalysisServices: !orderFilters.showAnalysisServices })}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition-colors',
                      orderFilters.showAnalysisServices
                        ? 'bg-foreground text-background border-foreground'
                        : 'bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'
                    )}
                  >
                    <ListTree className="h-3.5 w-3.5" />
                    Services
                  </button>
                  {/* Sort controls */}
                  {(
                    <div className="flex items-center gap-0.5 border border-border rounded-md overflow-hidden">
                      {([
                        { key: 'order_id', label: 'Order ID' },
                        { key: 'processing_time', label: 'Since order' },
                      ] as const).map(opt => {
                        const isActive = orderFilters.kanbanSort === opt.key
                        return (
                          <button
                            key={opt.key}
                            type="button"
                            onClick={() => {
                              if (isActive) {
                                updateFilters({ kanbanSortDir: orderFilters.kanbanSortDir === 'asc' ? 'desc' : 'asc' })
                              } else {
                                updateFilters({
                                  kanbanSort: opt.key,
                                  kanbanSortDir: opt.key === 'processing_time' ? 'desc' : 'asc',
                                })
                              }
                            }}
                            className={cn(
                              'flex items-center gap-1 px-2 py-1 text-xs font-medium transition-colors',
                              isActive
                                ? 'bg-foreground text-background'
                                : 'bg-transparent text-muted-foreground hover:text-foreground'
                            )}
                          >
                            {opt.label}
                            {isActive && (
                              <ArrowUpDown className="h-3 w-3 opacity-70" />
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </>
              )}
              <button
                type="button"
                title="Table view"
                onClick={() => updateFilters({ viewMode: 'table' })}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition-colors',
                  orderFilters.viewMode === 'table'
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
                onClick={() => updateFilters({ viewMode: 'kanban', activeStates: [] })}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition-colors',
                  orderFilters.viewMode === 'kanban'
                    ? 'bg-foreground text-background border-foreground'
                    : 'bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'
                )}
              >
                <Columns3 className="h-3.5 w-3.5" />
                Kanban
              </button>
            </div>

            {attentionCount > 0 && (
              <div className="flex items-center gap-1.5 text-sm text-amber-500">
                <AlertTriangle className="h-4 w-4" />
                {attentionCount} order{attentionCount !== 1 ? 's' : ''} need
                {attentionCount === 1 ? 's' : ''} attention
              </div>
            )}
          </div>

          {/* Row 2: Sample state toggles — hidden in Kanban (columns already show all states) */}
          {orderFilters.viewMode === 'table' && <div className="flex flex-wrap items-center gap-1.5">
            {/* Active = no state filters (show all) */}
            <button
              type="button"
              title="Show all non-complete orders regardless of state"
              onClick={() => updateFilters({ activeStates: [] })}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium border transition-colors',
                orderFilters.activeStates.length === 0
                  ? 'bg-foreground text-background border-foreground'
                  : 'bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'
              )}
            >
              Active
            </button>
            {ANALYSIS_STATE_BUTTONS.map(btn => {
              const active = orderFilters.activeStates.includes(btn.key)
              const count = filterCounts[btn.key] ?? 0
              return (
                <button
                  key={btn.key}
                  type="button"
                  title={btn.tooltip}
                  onClick={() => toggleState(btn.key)}
                  className={cn(
                    'rounded-md px-3 py-1 text-xs font-medium border transition-colors inline-flex items-center gap-1.5',
                    active
                      ? 'bg-foreground text-background border-foreground'
                      : 'bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'
                  )}
                >
                  {btn.label}
                  {count > 0 && (
                    <span className={cn(
                      'rounded-full px-1.5 py-0.5 text-[10px] font-mono leading-none',
                      active ? 'bg-background/20' : 'bg-muted'
                    )}>
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>}

          {/* Row 3: Text filters */}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Order ID"
              value={orderFilters.orderIdFilter}
              onChange={e => updateFilters({ orderIdFilter: e.target.value })}
              className="h-7 w-32 text-xs"
            />
            <Input
              placeholder="Email"
              value={orderFilters.emailFilter}
              onChange={e => updateFilters({ emailFilter: e.target.value })}
              className="h-7 w-48 text-xs"
            />
            <Input
              placeholder="Sample ID"
              value={orderFilters.sampleIdFilter}
              onChange={e => updateFilters({ sampleIdFilter: e.target.value })}
              className="h-7 w-32 text-xs"
            />
            <Input
              placeholder="Analyte"
              value={orderFilters.analyteFilter}
              onChange={e => updateFilters({ analyteFilter: e.target.value })}
              className="h-7 w-36 text-xs"
            />
            <Input
              placeholder="Lot"
              value={orderFilters.lotFilter}
              onChange={e => updateFilters({ lotFilter: e.target.value })}
              className="h-7 w-32 text-xs"
            />
            {(orderFilters.orderIdFilter || orderFilters.emailFilter || orderFilters.sampleIdFilter || orderFilters.analyteFilter || orderFilters.lotFilter) && (
              <button
                type="button"
                onClick={() => updateFilters({ orderIdFilter: '', emailFilter: '', sampleIdFilter: '', analyteFilter: '', lotFilter: '' })}
                className="text-xs text-muted-foreground hover:text-foreground underline"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* Status matrix / Kanban */}
      {status?.connected && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">
                  {orderFilters.viewMode === 'kanban' ? 'Kanban Board' : 'Status Matrix'}
                </CardTitle>
                <CardDescription>
                  {ordersLoading
                    ? 'Loading orders...'
                    : `${displayedOrders.length} order${displayedOrders.length !== 1 ? 's' : ''} displayed`}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {ordersLoading && (
              <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Loading orders...
              </div>
            )}

            {ordersError && (
              <div className="flex items-center gap-2 text-destructive py-8 justify-center">
                <AlertCircle className="h-4 w-4" />
                Failed to load orders
              </div>
            )}

            {displayedOrders.length === 0 && !ordersLoading && (
              <div className="text-muted-foreground py-8 text-center">
                {orderFilters.slaAtRisk
                  ? 'No at-risk orders in current filter'
                  : showAll ? 'No orders found' : 'No open orders'}
              </div>
            )}

            {displayedOrders.length > 0 && orderFilters.viewMode === 'table' && (
              <div className="overflow-auto max-h-[850px]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-card border-b">
                    <tr className="text-left text-muted-foreground">
                      <th className="py-2 px-3 font-medium whitespace-nowrap">Order ID</th>
                      <th className="py-2 px-3 font-medium whitespace-nowrap">Email</th>
                      <th className="py-2 px-3 font-medium whitespace-nowrap">Progress</th>
                      <th className="py-2 px-3 font-medium whitespace-nowrap">Created</th>
                      <th className="py-2 px-3 font-medium whitespace-nowrap">Timing</th>
                      <th className="py-2 px-3 font-medium whitespace-nowrap">SLA</th>
                      <th className="py-2 px-3 font-medium">Sample Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {displayedOrders.map(order => (
                      <OrderRow
                        key={order.id}
                        order={order}
                        wordpressHost={wordpressHost}
                        sampleLookupMap={sampleLookupMap}
                        activeAnalysisStates={orderFilters.activeStates}
                        highlightLot={orderFilters.lotFilter.trim() || undefined}
                        slaVerdict={orderSla.verdictByOrderId.get(order.order_id)}
                        sampleSlaStatusesMap={orderSla.sampleStatusesBySampleId}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {displayedOrders.length > 0 && orderFilters.viewMode === 'kanban' && (
              <div className="overflow-auto max-h-[850px]">
                <KanbanView
                  orders={displayedOrders}
                  sampleLookupMap={sampleLookupMap}
                  groupByOrder={orderFilters.groupByOrder}
                  activeStates={orderFilters.activeStates}
                  showAnalysisServices={orderFilters.showAnalysisServices}
                  lotHighlight={orderFilters.lotFilter.trim() || undefined}
                  sampleSlaStatusesMap={orderSla.sampleStatusesBySampleId}
                  collapsedCols={orderFilters.collapsedKanbanCols}
                  onToggleCollapse={toggleCollapsedCol}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
