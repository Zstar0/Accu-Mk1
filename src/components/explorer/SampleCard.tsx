import { AlertTriangle, RefreshCw } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'
import type { SenaiteLookupResult } from '@/lib/api'
import {
  AnalysisCounts,
  SampleStateBadge,
  formatTimeSince,
  groupAnalysisStates,
} from './helpers'

export function SampleCard({
  sampleId,
  lookup,
  isLoading,
  isError,
  className,
  analyte,
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
        <div className="text-xs text-muted-foreground">Failed to load</div>
      </div>
    )
  }

  const counts = groupAnalysisStates(lookup.analyses, lookup.review_state)
  const needsAttention = counts.to_verify > 0

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
      </div>
      {analyteEl}
      <div className="flex items-center gap-2">
        <AnalysisCounts counts={counts} needsAttention={needsAttention} />
        {lookup.date_received &&
          lookup.review_state !== 'published' &&
          (() => {
            const hrs =
              (Date.now() - new Date(lookup.date_received).getTime()) /
              3_600_000
            const timeStr = formatTimeSince(lookup.date_received)
            const goalNote =
              hrs > 48
                ? 'Over 48h — exceeds processing goal'
                : hrs > 24
                  ? 'Over 24h — approaching processing goal limit'
                  : 'Within 24h processing goal'
            return (
              <span
                className={cn(
                  'text-[10px] font-mono ml-auto shrink-0',
                  hrs > 48
                    ? 'text-red-400'
                    : hrs > 24
                      ? 'text-amber-400'
                      : 'text-muted-foreground'
                )}
                title={`Time since received in lab: ${timeStr}. ${goalNote}`}
              >
                {timeStr}
              </span>
            )
          })()}
      </div>
    </div>
  )
}
