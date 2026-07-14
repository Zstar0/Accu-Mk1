import { useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ExplorerOrder, SenaiteLookupResult } from '@/lib/api'
import type { OrderSlaVerdict } from '@/lib/sla-resolution'
import type { SampleSlaSnapshot } from '@/services/order-sla'
import { FlagIndicator } from '@/components/flags/FlagIndicator'
import { OrderFinancePanel } from './OrderFinancePanel'
import { OrderSlaCell } from './OrderSlaCell'
import { SampleCard } from './SampleCard'
import {
  COL_COUNT_LABEL,
  STATE_BORDER_CLASS,
  formatDate,
  formatProcessingTime,
  formatTimeSince,
  getOrderEmail,
  getOrderProgress,
  getOrderReceivedAt,
  getOrderWorstState,
  groupAnalysisStates,
  HighlightMatch,
  isOrderDone,
  sampleMatchesAnalysisFilter,
} from './helpers'

export function OrderRow({
  order,
  wordpressHost,
  sampleLookupMap,
  activeAnalysisStates,
  defaultExpanded,
  highlightSampleId,
  highlightLot,
  showFinance,
  slaVerdict,
  sampleSlaStatusesMap,
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
  // Phase 30 — search-result rendering props.
  //
  // `defaultExpanded`: semantic intent only. OrderRow currently renders all
  // sample cards inline (no expand/collapse state). Task 7 passes this when a
  // search is active so the caller's intent is recorded; introducing real
  // collapse is out of scope here and would regress the existing
  // /explorer/orders UX. The value drives `data-expanded` on the root <tr>
  // so component tests and Playwright can target search-active rows.
  //
  // `highlightSampleId`: when set, the SampleCard whose sampleId matches gets
  // a ring-2 ring-primary outline so the user can spot which sample drove the
  // search hit. Also mirrored to `data-highlight-sample-id` on the root <tr>.
  defaultExpanded?: boolean
  highlightSampleId?: string
  // Active lot-search query — forwarded to each SampleCard (and the
  // failed-sample inline card) for browser-find-style highlighting of the
  // matched substring inside the displayed lot value. Presentational only.
  highlightLot?: string
  // Opt-in (customer-detail only). When true, renders a chevron in the Order ID
  // cell that toggles a live WooCommerce finance disclosure row beneath this one.
  // Off by default so the shared /explorer OrderStatusPage view is unchanged.
  showFinance?: boolean
  // D2: order-aggregated SLA verdict. Undefined means "loading" (the cell renders
  // a muted loading dot). The parent passes verdicts from useOrderSlaStatuses.
  slaVerdict?: OrderSlaVerdict
  // D2 follow-on: per-sample SLA snapshots keyed by senaiteId. Each value is
  // an array (one entry per service group the sample touches) per the multi-
  // tier reshape; OrderRow forwards the first entry to SampleCard which still
  // renders a single indicator. Multi-row UI lands in a follow-on commit.
  // Undefined when the page hasn't plumbed it yet; SampleCard renders no
  // indicator in that case.
  sampleSlaStatusesMap?: Map<string, SampleSlaSnapshot[]>
}) {
  const [financeExpanded, setFinanceExpanded] = useState(false)
  const wpUrl = `${wordpressHost}/wp-admin/post.php?post=${order.order_id}&action=edit`

  // Phase 31 — surface analyte (sample_identity) on each SampleCard.
  // sample_results keys are stringified positional indexes ("1", "2", ...) that
  // align with payload.samples[0], payload.samples[1], ... — same ordering used
  // by the WP→IS integration. Localized type assertion (not a global widen) so
  // the fix stays surgical; legacy orders without payload.samples just yield
  // undefined and the card omits the analyte row.
  const payloadSamples = (
    order.payload as
      | { samples?: { sample_identity?: string; lot_code?: string }[] }
      | null
      | undefined
  )?.samples
  const sampleEntries = order.sample_results
    ? Object.entries(order.sample_results).map(([key, val]) => {
        const idx = parseInt(key, 10) - 1
        const payloadSample = Number.isNaN(idx) ? undefined : payloadSamples?.[idx]
        const trimmed = payloadSample?.sample_identity?.trim()
        const trimmedLot = payloadSample?.lot_code?.trim()
        return {
          name: key,
          senaiteId: val.senaite_id,
          integrationStatus: val.status,
          analyte: trimmed && trimmed.length > 0 ? trimmed : undefined,
          lot: trimmedLot && trimmedLot.length > 0 ? trimmedLot : undefined,
        }
      })
    : []

  const visibleSampleEntries = sampleEntries.filter(s => {
    if (s.integrationStatus === 'failed' || !s.senaiteId)
      return activeAnalysisStates.length === 0
    return sampleMatchesAnalysisFilter(
      s.senaiteId,
      activeAnalysisStates,
      sampleLookupMap
    )
  })

  const hasAttention = sampleEntries.some(s => {
    const lookup = sampleLookupMap.get(s.senaiteId)
    if (!lookup?.data) return false
    return (
      groupAnalysisStates(lookup.data.analyses, lookup.data.review_state)
        .to_verify > 0
    )
  })

  // Plan 6: the order's samples for the at-a-glance flag rollup. All
  // successfully-created samples (ignores the analysis filter so the indicator
  // reflects the whole order), keyed by the SENAITE id that IS the flag entity.
  const flagSampleIds = Object.values(order.sample_results ?? {})
    .filter(s => s.status !== 'failed' && s.senaite_id)
    .map(s => s.senaite_id)

  const worstState = getOrderWorstState(order, sampleLookupMap)
  const done = isOrderDone(order, sampleLookupMap)
  const progress = getOrderProgress(order, sampleLookupMap)
  // D1: order-level "Outstanding" = time since the lab first received a sample.
  // null until any sample is received — surfaced as "Awaiting sample" so orders
  // placed long ago but never received stand out for follow-up.
  const receivedAt = getOrderReceivedAt(order, sampleLookupMap)
  const outstanding = formatTimeSince(receivedAt)

  // Behavior-preserving cleanup per RESEARCH §11 #3: the inline IIFE at the
  // former OrderStatusPage:465-469 duplicated getOrderEmail. Collapsing to a
  // single helper call produces identical output.
  const email = getOrderEmail(order)

  const worstLabel = worstState
    ? (COL_COUNT_LABEL[worstState] ?? worstState)
    : null

  return (
    <>
    <tr
      // Phase 30 — search-result test/E2E targeting. `data-expanded` echoes the
      // PROP (OrderRow has no internal collapse state today; the prop signals
      // search-mode intent for callers and downstream snapshot/E2E selectors).
      // `data-highlight-sample-id` carries the matching sample id so E2E can
      // assert on it without having to walk into the SampleCard children.
      data-testid="order-row"
      data-expanded={defaultExpanded ? 'true' : 'false'}
      data-highlight-sample-id={highlightSampleId ?? ''}
      className={cn(
        'align-top border-l-3',
        done && 'opacity-45',
        hasAttention && 'bg-amber-500/[0.03]',
        worstState
          ? (STATE_BORDER_CLASS[worstState] ?? 'border-l-transparent')
          : 'border-l-transparent'
      )}
      title={worstLabel ? `Earliest sample stage: ${worstLabel}` : undefined}
    >
      <td className="py-3 px-3 whitespace-nowrap">
        <div className="flex items-center gap-1.5">
          {showFinance && (
            <button
              type="button"
              onClick={() => setFinanceExpanded(e => !e)}
              aria-expanded={financeExpanded}
              aria-label={
                financeExpanded ? 'Hide finance details' : 'Show finance details'
              }
              className="text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
            >
              {financeExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
          )}
          <a
            href={wpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-sm text-primary hover:underline"
          >
            {order.order_id}
            <ExternalLink className="h-3 w-3" />
          </a>
          <FlagIndicator
            scope={{
              kind: 'order',
              orderId: order.order_id,
              sampleIds: flagSampleIds,
              label: `#${order.order_number}`,
            }}
            variant="pill"
          />
        </div>
      </td>
      <td className="py-3 px-3">
        {email ? (
          <span className="text-sm block" title={email}>
            {email}
          </span>
        ) : (
          <span className="text-muted-foreground">{'—'}</span>
        )}
      </td>
      <td className="py-3 px-3 whitespace-nowrap">
        {progress.total > 0 ? (
          <div className="flex items-center gap-2">
            <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  progress.done === progress.total
                    ? 'bg-green-500'
                    : 'bg-blue-500'
                )}
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
            <span className="text-xs font-mono text-muted-foreground">
              {progress.done}/{progress.total}
            </span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">{'—'}</span>
        )}
      </td>
      <td className="py-3 px-3 whitespace-nowrap text-sm text-muted-foreground">
        {formatDate(order.created_at)}
      </td>
      <td className="py-3 px-3 whitespace-nowrap align-top">
        <div className="flex flex-col gap-0.5 text-xs">
          <span
            title={
              order.completed_at
                ? 'Total time from order placed to completion'
                : 'Elapsed since the order was placed'
            }
          >
            <span className="text-muted-foreground mr-1">Order</span>
            <span
              data-testid="order-time-since-order"
              className={cn(
                'font-mono',
                order.completed_at ? 'text-green-600' : 'text-yellow-600'
              )}
            >
              {formatProcessingTime(order.created_at, order.completed_at)}
            </span>
          </span>
          <span
            title={
              receivedAt
                ? 'Elapsed since the lab received a sample (outstanding)'
                : 'No sample received yet'
            }
          >
            <span className="text-muted-foreground mr-1">Lab</span>
            <span
              data-testid="order-outstanding"
              className="font-mono text-muted-foreground"
            >
              {outstanding ?? 'Awaiting sample'}
            </span>
          </span>
        </div>
      </td>
      <td className="py-3 px-3 whitespace-nowrap align-top">
        <OrderSlaCell verdict={slaVerdict ?? { color: 'awaiting' }} isLoading={!slaVerdict} />
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
                    {s.analyte && (
                      <div
                        className="text-xs text-muted-foreground truncate mb-1"
                        title={s.analyte}
                      >
                        {s.analyte}
                      </div>
                    )}
                    {s.lot && (
                      <div
                        className="text-xs text-muted-foreground truncate mb-1"
                        title={s.lot}
                      >
                        Lot: <HighlightMatch text={s.lot} query={highlightLot} />
                      </div>
                    )}
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
                  analyte={s.analyte}
                  lot={s.lot}
                  highlightLot={highlightLot}
                  slaSnapshots={sampleSlaStatusesMap?.get(s.senaiteId)}
                  className={cn(
                    highlightSampleId === s.senaiteId &&
                      'ring-2 ring-primary ring-offset-2'
                  )}
                />
              )
            })}
          </div>
        )}
      </td>
    </tr>
    {showFinance && financeExpanded && (
      <tr data-testid="order-finance-row" className="bg-muted/20">
        <td colSpan={7} className="p-0">
          <OrderFinancePanel
            orderId={order.order_id}
            enabled={financeExpanded}
          />
        </td>
      </tr>
    )}
    </>
  )
}
