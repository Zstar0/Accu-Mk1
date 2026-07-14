import { AlertTriangle, RefreshCw } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'
import { FlagIndicator } from '@/components/flags/FlagIndicator'
import type { SenaiteLookupResult } from '@/lib/api'
import type { SampleSlaSnapshot } from '@/services/order-sla'
import {
  AnalysisCounts,
  SampleStateBadge,
  groupAnalysisStates,
} from './helpers'
import { SampleSlaIndicator } from './SampleSlaIndicator'

export function SampleCard({
  sampleId,
  lookup,
  isLoading,
  isError,
  className,
  analyte,
  lot,
  slaSnapshots,
}: {
  sampleId: string
  lookup: SenaiteLookupResult | undefined
  isLoading: boolean
  isError: boolean
  // Phase 30 — caller-supplied class composition. Appended last so callers can
  // override or augment built-in styling (e.g. search-result ring highlight
  // from OrderRow). Applied to the root element on every render branch
  // (loading, error, normal) so test selectors and visual cues work for any
  // lookup state.
  className?: string
  // Phase 31 — at-a-glance analyte display. Sourced from
  // `order.payload.samples[i].sample_identity` (positional alignment with
  // sample_results keys). Available on all three render branches because the
  // value comes from the order payload, not from SENAITE — so it shows up even
  // while the lookup is loading or has errored. When undefined/empty the
  // sub-row is omitted so empty orders don't get a whitespace gap.
  analyte?: string
  // Sample lot — payload-sourced (`order.payload.samples[i].lot_code`), same
  // positional-alignment contract as `analyte`, so it shows on all three
  // render branches. On the normal branch the SENAITE lookup's `client_lot`
  // (authoritative — lab-editable after AR creation) wins over this prop.
  // When neither source has a non-blank value the row is omitted.
  lot?: string
  // Multi-tier follow-on — per-sample SLA snapshots, one entry per service
  // group the sample's analyses touch. Replaces the legacy hardcoded 24h/48h
  // goalNote with the real tier-resolved indicator (priority>group>default
  // precedence, business-hours math, configurable amber threshold). Only used
  // on the normal render branch when the sample is non-published with a
  // date_received — same gate as the legacy timer. useOrderSlaStatuses
  // returns undefined for published or unresolved samples; when the prop is
  // omitted (or empty array) the indicator simply doesn't render.
  slaSnapshots?: SampleSlaSnapshot[]
}) {
  const navigateToSample = useUIStore(state => state.navigateToSample)
  const hasAnalyte = typeof analyte === 'string' && analyte.length > 0
  const analyteEl = hasAnalyte ? (
    <div
      data-testid={`sample-card-analyte-${sampleId}`}
      className="text-xs text-muted-foreground truncate mb-1"
      title={analyte}
    >
      {analyte}
    </div>
  ) : null

  const payloadLot =
    typeof lot === 'string' && lot.trim().length > 0 ? lot.trim() : undefined
  const lotRow = (value: string | undefined) =>
    value ? (
      <div
        data-testid={`sample-card-lot-${sampleId}`}
        className="text-xs text-muted-foreground truncate mb-1"
        title={value}
      >
        Lot: {value}
      </div>
    ) : null

  if (isLoading) {
    return (
      <div
        data-testid={`sample-card-${sampleId}`}
        className={cn(
          'rounded-md border border-border/50 bg-muted/30 px-3 py-2 min-w-[160px]',
          className
        )}
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
          <RefreshCw className="h-3 w-3 animate-spin" />
          <span className="font-mono">{sampleId}</span>
        </div>
        {analyteEl}
        {lotRow(payloadLot)}
      </div>
    )
  }

  if (isError || !lookup) {
    return (
      <div
        data-testid={`sample-card-${sampleId}`}
        className={cn(
          'rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 min-w-[160px]',
          className
        )}
      >
        <span className="text-xs font-mono text-destructive">{sampleId}</span>
        {analyteEl}
        {lotRow(payloadLot)}
        <div className="text-xs text-muted-foreground">Failed to load</div>
      </div>
    )
  }

  const counts = groupAnalysisStates(lookup.analyses, lookup.review_state)
  const needsAttention = counts.to_verify > 0
  const clientLot =
    lookup.client_lot && lookup.client_lot.trim().length > 0
      ? lookup.client_lot.trim()
      : undefined

  return (
    <div
      data-testid={`sample-card-${sampleId}`}
      className={cn(
        'rounded-md border px-3 py-2 min-w-[160px] transition-colors',
        needsAttention
          ? 'border-amber-500/50 bg-amber-500/5'
          : 'border-border/50 bg-card',
        className
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
        <span className="ml-auto shrink-0">
          <FlagIndicator scope={{ kind: 'sample', sampleId }} />
        </span>
      </div>
      {analyteEl}
      {lotRow(clientLot ?? payloadLot)}
      <div className="flex items-center gap-2">
        <AnalysisCounts counts={counts} needsAttention={needsAttention} />
        {lookup.date_received && lookup.review_state !== 'published' && (
          <span className="ml-auto shrink-0">
            <SampleSlaIndicator snapshots={slaSnapshots} />
          </span>
        )}
      </div>
    </div>
  )
}
