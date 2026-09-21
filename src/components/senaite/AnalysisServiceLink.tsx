import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { SquareArrowOutUpRight } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  listServiceSpecs,
  type AnalysisServiceRecord,
  type AnalysisServiceSpecRecord,
  type SenaiteAnalysis,
} from '@/lib/api'
import { useAnalysisServices } from '@/services/analysis-services'
import { ruleLabel, tierChip } from '@/components/hplc/ServiceSpecsSection'
import { useUIStore } from '@/store/ui-store'

/**
 * Resolve the analysis_services row behind an analysis line. The row's own
 * analysis_service_id wins (keyword scans collide across origins); SENAITE
 * rows carry no id, so they fall back to a keyword match, disambiguated by
 * origin. Ambiguous or unknown resolves to null (no icon).
 */
export function resolveServiceForAnalysis(
  analysis: Pick<
    SenaiteAnalysis,
    'analysis_service_id' | 'keyword' | 'service_origin'
  >,
  services: AnalysisServiceRecord[] | undefined
): AnalysisServiceRecord | null {
  if (!services) return null
  if (analysis.analysis_service_id != null)
    return services.find(s => s.id === analysis.analysis_service_id) ?? null
  if (!analysis.keyword) return null
  const hits = services.filter(s => s.keyword === analysis.keyword)
  if (hits.length <= 1) return hits[0] ?? null
  const origin = analysis.service_origin ?? 'senaite'
  const sameOrigin = hits.filter(s => s.origin === origin)
  return sameOrigin.length === 1 ? (sameOrigin[0] ?? null) : null
}

/**
 * Spec rows worth showing for this line: every active non-peptide row (matrix
 * and default tiers) plus the row bound to this line's own peptide. Other
 * peptides' rows are noise on a generic native service.
 */
export function specsForAnalysis(
  specs: AnalysisServiceSpecRecord[],
  peptideId: number | null | undefined
): AnalysisServiceSpecRecord[] {
  return specs.filter(
    s => s.active && (s.peptide_id == null || s.peptide_id === peptideId)
  )
}

/** When the result was captured at the bench. The table has no Captured
 *  column any more (slice 22), so the hover is where it is read. */
function formatCaptured(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Pure hover card: line details + the service's filed specs. */
export function AnalysisServiceTooltip({
  analysis,
  service,
  specs,
}: {
  analysis: SenaiteAnalysis
  service: AnalysisServiceRecord
  /** undefined = still loading */
  specs: AnalysisServiceSpecRecord[] | undefined
}) {
  const native = analysis.uid?.startsWith('mk1:')
  const details: [string, string | null | undefined][] = [
    ['Keyword', service.keyword],
    [
      'Service',
      service.origin === 'mk1' ? 'Accu-Mk1 native' : 'SENAITE-sourced',
    ],
    ['Stored in', native ? 'Accu-Mk1 (no SENAITE record)' : 'SENAITE'],
    ['Result type', service.result_type],
    ['Unit', analysis.unit ?? service.unit],
    ['Method', analysis.method],
    ['Instrument', analysis.instrument],
    ['Analyst', analysis.analyst],
    ['Captured', formatCaptured(analysis.captured)],
    ['State', analysis.review_state],
  ]
  const shown = specs ? specsForAnalysis(specs, analysis.peptide_id) : []
  return (
    <div
      data-testid="analysis-service-tooltip"
      className="flex flex-col gap-1.5 p-3 text-xs font-mono"
    >
      <div className="font-semibold border-b border-primary-foreground/20 pb-1.5">
        {service.title}
      </div>
      <div className="flex flex-col gap-0.5">
        {details
          .filter(([, v]) => v != null && v !== '')
          .map(([k, v]) => (
            <div key={k}>
              <span className="opacity-60">{k}:</span> {v}
            </div>
          ))}
      </div>
      <div className="flex flex-col gap-0.5 border-t border-primary-foreground/20 pt-1.5">
        <div className="opacity-60">Specs</div>
        {specs === undefined ? (
          <div className="opacity-70">Loading...</div>
        ) : shown.length === 0 ? (
          <div className="opacity-70">No active spec filed</div>
        ) : (
          shown.map(s => (
            <div key={s.id}>
              <span className="opacity-60">{tierChip(s)}:</span> {ruleLabel(s)}
            </div>
          ))
        )}
      </div>
      <div className="border-t border-primary-foreground/20 pt-1.5 opacity-60">
        Click to open the analysis service
      </div>
    </div>
  )
}

/**
 * Per-line icon on the analyses list: click opens the line's analysis service
 * flyout in LIMS > Analysis Services; hover shows the line's details and the
 * specs filed on that service. Specs load on first hover, not per row.
 */
export function AnalysisServiceLink({
  analysis,
}: {
  analysis: SenaiteAnalysis
}) {
  const [open, setOpen] = useState(false)
  const services = useAnalysisServices().data
  const service = resolveServiceForAnalysis(analysis, services)
  const specs = useQuery({
    queryKey: ['analysis-services', service?.id, 'specs'],
    queryFn: () => listServiceSpecs(service?.id ?? 0),
    enabled: open && service != null,
    staleTime: 1000 * 60,
  }).data
  if (!service) return null
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Open analysis service ${service.title}`}
          className="inline-flex shrink-0 cursor-pointer text-muted-foreground/60 hover:text-foreground transition-colors"
          onClick={e => {
            e.stopPropagation()
            useUIStore.getState().navigateToAnalysisService(service.id)
          }}
        >
          <SquareArrowOutUpRight size={11} />
        </button>
      </TooltipTrigger>
      <TooltipContent className="p-0 max-w-xs">
        <AnalysisServiceTooltip
          analysis={analysis}
          service={service}
          specs={specs}
        />
      </TooltipContent>
    </Tooltip>
  )
}
