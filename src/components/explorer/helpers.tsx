import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import type {
  ExplorerOrder,
  SenaiteAnalysis,
  SenaiteLookupResult,
} from '@/lib/api'

// --- Analysis state helpers ---

export type AnalysisStateCounts = {
  sample_due: number
  received: number
  assigned: number
  to_verify: number
  waiting_for_addon: number
  ready_for_review: number
  verified: number
  published: number
  pending: number
}

export function groupAnalysisStates(
  analyses: SenaiteAnalysis[],
  sampleReviewState?: string | null
): AnalysisStateCounts {
  const counts: AnalysisStateCounts = {
    sample_due: 0,
    received: 0,
    assigned: 0,
    to_verify: 0,
    waiting_for_addon: 0,
    ready_for_review: 0,
    verified: 0,
    published: 0,
    pending: 0,
  }
  for (const a of analyses) {
    const state = a.review_state?.toLowerCase()
    if (state === 'assigned') counts.assigned++
    else if (state === 'to_be_verified') counts.to_verify++
    else if (state === 'published') counts.published++
    else if (state === 'verified') counts.verified++
    else if (
      state === 'rejected' ||
      state === 'cancelled' ||
      state === 'invalid' ||
      state === 'retracted'
    ) {
      /* terminal — skip */
    } else counts.pending++ // registered, unassigned, etc.
  }
  // Sample-level states
  const sState = sampleReviewState?.toLowerCase()
  if (sState === 'sample_due') counts.sample_due = 1
  if (sState === 'received' || sState === 'sample_received') counts.received = 1
  if (sState === 'waiting_for_addon_results') counts.waiting_for_addon = 1
  if (sState === 'ready_for_review') counts.ready_for_review = 1
  if (sState === 'published') counts.published = 1
  return counts
}

// --- Formatters (shared with OrderExplorer) ---

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const date = new Date(dateStr)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatProcessingTime(
  createdAt: string,
  completedAt: string | null
): string {
  const start = new Date(createdAt)
  const end = completedAt ? new Date(completedAt) : new Date()
  const ms = end.getTime() - start.getTime()
  if (ms < 0) return '—'
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

export const TEST_EMAILS = [
  'forrestp@outlook.com',
  'forrest@valenceanalytical.com',
]

export function getOrderEmail(order: ExplorerOrder): string | null {
  const p = order.payload as Record<string, unknown> | null
  if (!p?.billing || typeof p.billing !== 'object') return null
  return ((p.billing as Record<string, unknown>).email as string) ?? null
}

// --- Sub-components ---

export function SampleStateBadge({ state }: { state: string | null }) {
  const s = state?.toLowerCase() ?? 'unknown'
  const config: Record<
    string,
    {
      variant: 'default' | 'secondary' | 'destructive' | 'outline'
      label: string
    }
  > = {
    received: { variant: 'secondary', label: 'Received' },
    sample_received: { variant: 'secondary', label: 'Received' },
    to_be_verified: { variant: 'default', label: 'To Verify' },
    verified: { variant: 'default', label: 'Verified' },
    published: { variant: 'default', label: 'Published' },
    sample_due: { variant: 'outline', label: 'Sample Due' },
    waiting_for_addon_results: { variant: 'secondary', label: 'Waiting Addon' },
    ready_for_review: { variant: 'default', label: 'Ready for Review' },
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

export function AnalysisCounts({
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

// --- Sample/order analysis-state helpers ---

export function sampleMatchesAnalysisFilter(
  senaiteId: string,
  activeStates: string[],
  sampleLookupMap: Map<
    string,
    { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
  >
): boolean {
  if (activeStates.length === 0) return true
  const lookup = sampleLookupMap.get(senaiteId)
  if (!lookup?.data) return true // still loading — keep visible
  const counts = groupAnalysisStates(
    lookup.data.analyses,
    lookup.data.review_state
  )
  return activeStates.some(state => {
    if (state === 'sample_due') return counts.sample_due > 0
    if (state === 'received') return counts.received > 0
    if (state === 'pending') return counts.pending > 0
    if (state === 'assigned') return counts.assigned > 0
    if (state === 'to_verify') return counts.to_verify > 0
    if (state === 'waiting_for_addon') return counts.waiting_for_addon > 0
    if (state === 'ready_for_review') return counts.ready_for_review > 0
    if (state === 'verified') return counts.verified > 0
    if (state === 'published') return counts.published > 0
    return false
  })
}

// Priority of states — lower = earlier in pipeline = "more behind"
export const STATE_PRIORITY: Record<string, number> = {
  sample_due: 0,
  received: 1,
  pending: 2,
  assigned: 3,
  to_verify: 4,
  waiting_for_addon: 5,
  ready_for_review: 6,
  verified: 7,
  published: 8,
}

// Left border color for the "worst" (most behind) state in an order
export const STATE_BORDER_CLASS: Record<string, string> = {
  sample_due: 'border-l-yellow-500',
  received: 'border-l-cyan-500',
  pending: 'border-l-zinc-500',
  assigned: 'border-l-blue-500',
  to_verify: 'border-l-amber-500',
  waiting_for_addon: 'border-l-indigo-500',
  ready_for_review: 'border-l-teal-500',
  verified: 'border-l-green-500',
  published: 'border-l-purple-500',
}

export function getOrderWorstState(
  order: ExplorerOrder,
  sampleLookupMap: Map<
    string,
    { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
  >
): string | null {
  let worst: string | null = null
  let worstPri = Infinity
  if (!order.sample_results) return null
  for (const entry of Object.values(order.sample_results)) {
    const lookup = sampleLookupMap.get(entry.senaite_id)
    if (!lookup?.data) continue
    const counts = groupAnalysisStates(
      lookup.data.analyses,
      lookup.data.review_state
    )
    for (const [key, val] of Object.entries(counts)) {
      if (val > 0 && (STATE_PRIORITY[key] ?? 99) < worstPri) {
        worstPri = STATE_PRIORITY[key] ?? 99
        worst = key
      }
    }
  }
  return worst
}

export function isOrderDone(
  order: ExplorerOrder,
  sampleLookupMap: Map<
    string,
    { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
  >
): boolean {
  if (!order.sample_results) return false
  const entries = Object.values(order.sample_results)
  if (entries.length === 0) return false
  // An order is "done" only when every sample is published in SENAITE.
  // Verified-but-not-published samples (results approved, COA not yet issued)
  // keep the order active at full opacity. Sample-level review_state is the
  // authoritative publish signal — see explorer-helpers.test.ts.
  return entries.every(entry => {
    const lookup = sampleLookupMap.get(entry.senaite_id)
    if (!lookup?.data) return false
    return lookup.data.review_state?.toLowerCase() === 'published'
  })
}

export function getOrderProgress(
  order: ExplorerOrder,
  sampleLookupMap: Map<
    string,
    { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
  >
): { done: number; total: number } {
  let done = 0
  let total = 0
  if (!order.sample_results) return { done: 0, total: 0 }
  for (const entry of Object.values(order.sample_results)) {
    const lookup = sampleLookupMap.get(entry.senaite_id)
    if (!lookup?.data) continue
    for (const a of lookup.data.analyses) {
      const s = a.review_state?.toLowerCase()
      if (
        s === 'rejected' ||
        s === 'cancelled' ||
        s === 'invalid' ||
        s === 'retracted'
      )
        continue
      total++
      if (s === 'verified' || s === 'published') done++
    }
  }
  return { done, total }
}

// Earliest date_received across an order's samples = when the lab first
// received anything for this order. Drives the order-level "Outstanding"
// (time-since-received) display. Returns null when no sample is received yet.
export function getOrderReceivedAt(
  order: ExplorerOrder,
  sampleLookupMap: Map<
    string,
    { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }
  >
): string | null {
  let earliest: number | null = null
  let earliestStr: string | null = null
  if (!order.sample_results) return null
  for (const entry of Object.values(order.sample_results)) {
    const received = sampleLookupMap.get(entry.senaite_id)?.data?.date_received
    if (!received) continue
    const t = new Date(received).getTime()
    if (Number.isNaN(t)) continue
    if (earliest === null || t < earliest) {
      earliest = t
      earliestStr = received
    }
  }
  return earliestStr
}

export function formatTimeSince(dateStr: string | null): string | null {
  if (!dateStr) return null
  const ms = Date.now() - new Date(dateStr).getTime()
  if (ms < 0) return null
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

// Human-readable label for the count in each column
export const COL_COUNT_LABEL: Record<string, string> = {
  sample_due: 'due',
  received: 'received',
  pending: 'pending',
  assigned: 'assigned',
  to_verify: 'to verify',
  waiting_for_addon: 'waiting addon',
  ready_for_review: 'ready for review',
  verified: 'verified',
  published: 'published',
}
