import { useState, useEffect, useMemo } from 'react'
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  XCircle,
  AlertCircle,
  Clock,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  getExplorerStatus,
  getExplorerOrders,
  lookupSenaiteSample,
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

// --- Senaite sequential fetch queue ---
// Serializes lookups so only one hits Senaite at a time (single-threaded Zope)
let _senaiteQueue: Promise<void> = Promise.resolve()

function enqueueSenaiteLookup(id: string) {
  // Order Status page opts into the 15-min cache (noCache=false) to avoid hammering Zope.
  const task = _senaiteQueue.then(() => lookupSenaiteSample(id, false))
  _senaiteQueue = task.then(Function.prototype as () => void, Function.prototype as () => void)
  return task
}

// --- Analysis state helpers ---

type AnalysisStateCounts = {
  assigned: number
  to_verify: number
  verified: number
  pending: number
}

function groupAnalysisStates(analyses: SenaiteAnalysis[]): AnalysisStateCounts {
  const counts: AnalysisStateCounts = {
    assigned: 0,
    to_verify: 0,
    verified: 0,
    pending: 0,
  }
  for (const a of analyses) {
    const state = a.review_state?.toLowerCase()
    if (state === 'assigned') counts.assigned++
    else if (state === 'to_be_verified') counts.to_verify++
    else if (state === 'verified' || state === 'published') counts.verified++
    else counts.pending++ // registered, unassigned, etc.
  }
  return counts
}

// --- Formatters (shared with OrderExplorer) ---

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '\u2014'
  const date = new Date(dateStr)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatProcessingTime(
  createdAt: string,
  completedAt: string | null
): string {
  const start = new Date(createdAt)
  const end = completedAt ? new Date(completedAt) : new Date()
  const ms = end.getTime() - start.getTime()
  if (ms < 0) return '\u2014'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  if (seconds > 0) return `${seconds}s`
  return `${ms}ms`
}

const TEST_EMAILS = ['forrestp@outlook.com', 'forrest@valenceanalytical.com']

function getOrderEmail(order: ExplorerOrder): string | null {
  const p = order.payload as Record<string, unknown> | null
  if (!p?.billing || typeof p.billing !== 'object') return null
  return ((p.billing as Record<string, unknown>).email as string) ?? null
}

// --- Sub-components ---

function SampleStateBadge({ state }: { state: string | null }) {
  const s = state?.toLowerCase() ?? 'unknown'
  const config: Record<
    string,
    { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }
  > = {
    received: { variant: 'secondary', label: 'Received' },
    sample_received: { variant: 'secondary', label: 'Received' },
    to_be_verified: { variant: 'default', label: 'To Verify' },
    verified: { variant: 'default', label: 'Verified' },
    published: { variant: 'default', label: 'Published' },
    registered: { variant: 'outline', label: 'Registered' },
    sample_registered: { variant: 'outline', label: 'Registered' },
    invalid: { variant: 'destructive', label: 'Invalid' },
    rejected: { variant: 'destructive', label: 'Rejected' },
    cancelled: { variant: 'destructive', label: 'Cancelled' },
  }
  const c = config[s] || {
    variant: 'outline' as const,
    label: state ?? 'Unknown',
  }
  return (
    <Badge variant={c.variant} className="text-xs">
      {c.label}
    </Badge>
  )
}

function AnalysisCounts({
  counts,
  needsAttention,
}: {
  counts: AnalysisStateCounts
  needsAttention: boolean
}) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {counts.assigned > 0 && (
        <span>
          Assigned <span className="font-mono">{counts.assigned}</span>
        </span>
      )}
      {counts.to_verify > 0 && (
        <span className={cn(needsAttention && 'text-amber-500 font-medium')}>
          To verify <span className="font-mono">{counts.to_verify}</span>
        </span>
      )}
      {counts.verified > 0 && (
        <span className="text-green-600">
          Verified <span className="font-mono">{counts.verified}</span>
        </span>
      )}
      {counts.pending > 0 && (
        <span>
          Pending <span className="font-mono">{counts.pending}</span>
        </span>
      )}
    </div>
  )
}

function SampleCard({
  sampleId,
  lookup,
  isLoading,
  isError,
}: {
  sampleId: string
  lookup: SenaiteLookupResult | undefined
  isLoading: boolean
  isError: boolean
}) {
  const navigateToSample = useUIStore(state => state.navigateToSample)

  if (isLoading) {
    return (
      <div className="rounded-md border border-border/50 bg-muted/30 px-3 py-2 min-w-[160px]">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCw className="h-3 w-3 animate-spin" />
          <span className="font-mono">{sampleId}</span>
        </div>
      </div>
    )
  }

  if (isError || !lookup) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 min-w-[160px]">
        <span className="text-xs font-mono text-destructive">{sampleId}</span>
        <div className="text-xs text-muted-foreground">Failed to load</div>
      </div>
    )
  }

  const counts = groupAnalysisStates(lookup.analyses)
  const needsAttention = counts.to_verify > 0

  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2 min-w-[160px] transition-colors',
        needsAttention
          ? 'border-amber-500/50 bg-amber-500/5'
          : 'border-border/50 bg-card'
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <button
          type="button"
          className="text-xs font-mono font-medium text-primary hover:underline cursor-pointer"
          onClick={() => navigateToSample(sampleId)}
        >
          {sampleId}
        </button>
        <SampleStateBadge state={lookup.review_state} />
        {needsAttention && (
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
        )}
      </div>
      <AnalysisCounts counts={counts} needsAttention={needsAttention} />
    </div>
  )
}

// --- Order row ---

function sampleMatchesAnalysisFilter(
  senaiteId: string,
  activeStates: string[],
  sampleLookupMap: Map<string, { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }>
): boolean {
  if (activeStates.length === 0) return true
  const lookup = sampleLookupMap.get(senaiteId)
  if (!lookup?.data) return true // still loading — keep visible
  const counts = groupAnalysisStates(lookup.data.analyses)
  return activeStates.some(state => {
    if (state === 'pending') return counts.pending > 0
    if (state === 'assigned') return counts.assigned > 0
    if (state === 'to_verify') return counts.to_verify > 0
    if (state === 'verified') return counts.verified > 0
    return false
  })
}

function OrderRow({
  order,
  wordpressHost,
  sampleLookupMap,
  activeAnalysisStates,
}: {
  order: ExplorerOrder
  wordpressHost: string
  sampleLookupMap: Map<
    string,
    {
      data?: SenaiteLookupResult
      isLoading: boolean
      isError: boolean
    }
  >
  activeAnalysisStates: string[]
}) {
  const wpUrl = `${wordpressHost}/wp-admin/post.php?post=${order.order_id}&action=edit`

  const sampleEntries = order.sample_results
    ? Object.entries(order.sample_results).map(([key, val]) => ({
        name: key,
        senaiteId: val.senaite_id,
        integrationStatus: val.status,
      }))
    : []

  const visibleSampleEntries = sampleEntries.filter(s => {
    if (s.integrationStatus === 'failed' || !s.senaiteId) return activeAnalysisStates.length === 0
    return sampleMatchesAnalysisFilter(s.senaiteId, activeAnalysisStates, sampleLookupMap)
  })

  const hasAttention = sampleEntries.some(s => {
    const lookup = sampleLookupMap.get(s.senaiteId)
    if (!lookup?.data) return false
    return groupAnalysisStates(lookup.data.analyses).to_verify > 0
  })

  const email = (() => {
    const p = order.payload as Record<string, unknown> | null
    if (!p?.billing || typeof p.billing !== 'object') return null
    return ((p.billing as Record<string, unknown>).email as string) ?? null
  })()

  return (
    <tr className={cn('align-top', hasAttention && 'bg-amber-500/[0.03]')}>
      <td className="py-3 px-3 whitespace-nowrap">
        <a
          href={wpUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-mono text-sm text-primary hover:underline"
        >
          {order.order_id}
          <ExternalLink className="h-3 w-3" />
        </a>
      </td>
      <td className="py-3 px-3">
        {email ? (
          <span className="text-sm block" title={email}>
            {email}
          </span>
        ) : (
          <span className="text-muted-foreground">{'\u2014'}</span>
        )}
      </td>
      <td className="py-3 px-3 whitespace-nowrap text-sm">
        {order.samples_delivered}/{order.samples_expected}
      </td>
      <td className="py-3 px-3 whitespace-nowrap text-sm text-muted-foreground">
        {formatDate(order.created_at)}
      </td>
      <td className="py-3 px-3 whitespace-nowrap">
        <span
          className={cn(
            'font-mono text-sm',
            order.completed_at ? 'text-green-600' : 'text-yellow-600'
          )}
        >
          {formatProcessingTime(order.created_at, order.completed_at)}
        </span>
      </td>
      <td className="py-3 px-3">
        {visibleSampleEntries.length === 0 ? (
          <span className="text-muted-foreground text-xs">
            {sampleEntries.length === 0 ? 'No samples' : 'No matching samples'}
          </span>
        ) : (
          <div className="flex flex-wrap gap-2 max-w-[1060px]">
            {visibleSampleEntries.map(s => {
              // Sample never created in SENAITE (integration failure)
              if (s.integrationStatus === 'failed' || !s.senaiteId) {
                return (
                  <div
                    key={s.name}
                    className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 min-w-[160px]"
                  >
                    <span className="text-xs font-medium text-destructive">
                      {s.senaiteId || `Sample ${s.name}`}
                    </span>
                    <div className="text-xs text-muted-foreground">
                      Failed to create in SENAITE
                    </div>
                  </div>
                )
              }
              const lookup = sampleLookupMap.get(s.senaiteId)
              return (
                <SampleCard
                  key={s.senaiteId}
                  sampleId={s.senaiteId}
                  lookup={lookup?.data}
                  isLoading={lookup?.isLoading ?? true}
                  isError={lookup?.isError ?? false}
                />
              )
            })}
          </div>
        )}
      </td>
    </tr>
  )
}

// --- Sample state filter config ---

const ANALYSIS_STATE_BUTTONS = [
  { key: 'pending', label: 'Pending' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'to_verify', label: 'To Verify' },
  { key: 'verified', label: 'Verified' },
] as const

// --- localStorage filter state ---

const FILTERS_LS_KEY = 'order-status-filters'

interface OrderFilters {
  activeStates: string[]
  sampleIdFilter: string
  emailFilter: string
  orderIdFilter: string
  hideTestOrders: boolean
}

function loadOrderFilters(): OrderFilters {
  try {
    const raw = localStorage.getItem(FILTERS_LS_KEY)
    if (raw) return JSON.parse(raw) as OrderFilters
  } catch {
    // ignore parse errors
  }
  return { activeStates: [], sampleIdFilter: '', emailFilter: '', orderIdFilter: '', hideTestOrders: true }
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
      activeStates: orderFilters.activeStates[0] === key ? [] : [key],
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
    let filtered = showAll ? allOrders : allOrders.filter(o => !o.completed_at)
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

  // Collect all unique sample IDs from displayed orders (skip failed/empty ones)
  const sampleIds = useMemo(() => {
    const ids: string[] = []
    for (const order of orders) {
      if (order.sample_results) {
        for (const entry of Object.values(order.sample_results)) {
          if (
            entry.senaite_id &&
            entry.status !== 'failed' &&
            !ids.includes(entry.senaite_id)
          ) {
            ids.push(entry.senaite_id)
          }
        }
      }
    }
    return ids
  }, [orders])

  // Fetch sample details from SENAITE — serialized to avoid overwhelming Zope
  const sampleQueries = useQueries({
    queries: sampleIds.map(id => ({
      queryKey: ['senaite', 'lookup', id],
      queryFn: () => enqueueSenaiteLookup(id),
      staleTime: 15 * 60_000,
      retry: 1,
    })),
  })

  // Build lookup map: sampleId → query result
  const sampleLookupMap = useMemo(() => {
    const map = new Map<
      string,
      {
        data?: SenaiteLookupResult
        isLoading: boolean
        isError: boolean
      }
    >()
    sampleIds.forEach((id, idx) => {
      map.set(id, {
        data: sampleQueries[idx]?.data,
        isLoading: sampleQueries[idx]?.isLoading ?? true,
        isError: sampleQueries[idx]?.isError ?? false,
      })
    })
    return map
  }, [sampleIds, sampleQueries])

  // Hide orders where no samples match the active analysis state filter
  const filteredOrders = useMemo(() => {
    if (orderFilters.activeStates.length === 0) return orders
    return orders.filter(o => {
      if (!o.sample_results) return false
      return Object.values(o.sample_results).some(v =>
        v.senaite_id && sampleMatchesAnalysisFilter(v.senaite_id, orderFilters.activeStates, sampleLookupMap)
      )
    })
  }, [orders, orderFilters.activeStates, sampleLookupMap])

  // Count orders needing attention (have samples with to_verify analyses)
  const attentionCount = useMemo(() => {
    let count = 0
    for (const order of orders) {
      if (!order.sample_results) continue
      for (const entry of Object.values(order.sample_results)) {
        const lookup = sampleLookupMap.get(entry.senaite_id)
        if (lookup?.data) {
          const counts = groupAnalysisStates(lookup.data.analyses)
          if (counts.to_verify > 0) {
            count++
            break
          }
        }
      }
    }
    return count
  }, [orders, sampleLookupMap])

  // Oldest cached_at from settled queries — shows when data was last fetched from Senaite
  const lastUpdated = useMemo(() => {
    let oldest: string | null = null
    for (const q of sampleQueries) {
      const ts = q.data?.cached_at
      if (ts && (!oldest || ts < oldest)) oldest = ts
    }
    return oldest
  }, [sampleQueries])

  const openCount = useMemo(() => {
    if (!allOrders) return 0
    let filtered = allOrders.filter(o => !o.completed_at)
    if (orderFilters.hideTestOrders) {
      filtered = filtered.filter(o => {
        const email = getOrderEmail(o)?.toLowerCase()
        return !email || !TEST_EMAILS.includes(email)
      })
    }
    return filtered.length
  }, [allOrders, orderFilters])

  // True while any senaite lookup is actively fetching
  const isRefreshing = sampleQueries.some(q => q.isFetching)

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
          {/* Row 1: Open/All + hide test + attention */}
          <div className="flex items-center gap-3">
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

            <label className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap cursor-pointer ml-1">
              <Checkbox
                checked={orderFilters.hideTestOrders}
                onCheckedChange={checked => updateFilters({ hideTestOrders: checked === true })}
              />
              Hide test orders
            </label>

            {attentionCount > 0 && (
              <div className="flex items-center gap-1.5 text-sm text-amber-500 ml-2">
                <AlertTriangle className="h-4 w-4" />
                {attentionCount} order{attentionCount !== 1 ? 's' : ''} need
                {attentionCount === 1 ? 's' : ''} attention
              </div>
            )}
          </div>

          {/* Row 2: Sample state toggles */}
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Active = no state filters (show all) */}
            <button
              type="button"
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
              return (
                <button
                  key={btn.key}
                  type="button"
                  onClick={() => toggleState(btn.key)}
                  className={cn(
                    'rounded-md px-3 py-1 text-xs font-medium border transition-colors',
                    active
                      ? 'bg-foreground text-background border-foreground'
                      : 'bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'
                  )}
                >
                  {btn.label}
                </button>
              )
            })}
          </div>

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
            {(orderFilters.orderIdFilter || orderFilters.emailFilter || orderFilters.sampleIdFilter) && (
              <button
                type="button"
                onClick={() => updateFilters({ orderIdFilter: '', emailFilter: '', sampleIdFilter: '' })}
                className="text-xs text-muted-foreground hover:text-foreground underline"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* Status matrix */}
      {status?.connected && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Status Matrix</CardTitle>
            <CardDescription>
              {ordersLoading
                ? 'Loading orders...'
                : `${filteredOrders.length} order${filteredOrders.length !== 1 ? 's' : ''} displayed`}
            </CardDescription>
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

            {filteredOrders.length === 0 && !ordersLoading && (
              <div className="text-muted-foreground py-8 text-center">
                {showAll ? 'No orders found' : 'No open orders'}
              </div>
            )}

            {filteredOrders.length > 0 && (
              <div className="overflow-auto max-h-[850px]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-card border-b">
                    <tr className="text-left text-muted-foreground">
                      <th className="py-2 px-3 font-medium whitespace-nowrap">
                        Order ID
                      </th>
                      <th className="py-2 px-3 font-medium whitespace-nowrap">
                        Email
                      </th>
                      <th className="py-2 px-3 font-medium whitespace-nowrap">
                        Samples
                      </th>
                      <th className="py-2 px-3 font-medium whitespace-nowrap">
                        Created
                      </th>
                      <th className="py-2 px-3 font-medium whitespace-nowrap">
                        Processing Time
                      </th>
                      <th className="py-2 px-3 font-medium">Sample Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {filteredOrders.map(order => (
                      <OrderRow
                        key={order.id}
                        order={order}
                        wordpressHost={wordpressHost}
                        sampleLookupMap={sampleLookupMap}
                        activeAnalysisStates={orderFilters.activeStates}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
