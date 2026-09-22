import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { AnalysisSpecification, SenaiteAnalysis } from '@/lib/api'

/** Spec text as the lab reads it: "≥ 98 %", "1 – 5 µg/g", "= Conforms",
 *  "As measured". A display override filed on the spec wins, exactly as it
 *  does on the certificate. Same wording as the catalog's ruleLabel. */
export function specText(spec: AnalysisSpecification): string {
  if (spec.display) return spec.display
  if (spec.rule_kind === 'informational') return 'As measured'
  if (spec.rule_kind === 'equals') return `= ${spec.equals ?? '–'}`
  const unit = spec.unit ? ` ${spec.unit}` : ''
  const loq = spec.loq != null ? ` · LOQ ${spec.loq}` : ''
  if (spec.min != null && spec.max != null)
    return `${spec.min} – ${spec.max}${unit}${loq}`
  if (spec.min != null) return `≥ ${spec.min}${unit}${loq}`
  if (spec.max != null) return `≤ ${spec.max}${unit}${loq}`
  return '–'
}

export type SpecVerdictTone = 'pass' | 'fail' | 'muted' | 'warn'

export interface SpecVerdict {
  label: string
  tone: SpecVerdictTone
}

/** How far outside the violated bound a failing range result sits, as the
 *  certificate prints it ("-1.02%"). null when it does not apply. */
export function specDeviation(
  spec: AnalysisSpecification,
  result: string | null | undefined
): string | null {
  if (spec.rule_kind !== 'range') return null
  const value = Number.parseFloat(String(result ?? ''))
  if (!Number.isFinite(value)) return null
  const bound =
    spec.min != null && value < spec.min
      ? spec.min
      : spec.max != null && value > spec.max
        ? spec.max
        : null
  if (bound == null || bound === 0) return null
  const pct = ((value - bound) / bound) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
}

/** The verdict line. The verdict itself is the backend's (`conforms`, judged
 *  by the same rule the COA uses); this only words it. */
export function specVerdict(
  analysis: Pick<SenaiteAnalysis, 'specification' | 'conforms' | 'result'>
): SpecVerdict | null {
  const spec = analysis.specification
  if (!spec) return null
  if (analysis.conforms === true) return { label: 'Conforms', tone: 'pass' }
  if (analysis.conforms === false) {
    const dev = specDeviation(spec, analysis.result)
    return {
      label: dev ? `Does not conform · ${dev}` : 'Does not conform',
      tone: 'fail',
    }
  }
  if (!String(analysis.result ?? '').trim())
    return { label: 'Pending', tone: 'muted' }
  if (spec.rule_kind === 'informational')
    return { label: 'Report only', tone: 'muted' }
  // A result is filed but the rule could not run (e.g. text on a numeric range).
  return { label: 'Not evaluated', tone: 'warn' }
}

const TONE_CLASS: Record<SpecVerdictTone, string> = {
  pass: 'text-emerald-600 dark:text-emerald-400',
  fail: 'text-red-600 dark:text-red-400 font-semibold',
  muted: 'text-muted-foreground',
  warn: 'text-amber-600 dark:text-amber-400',
}

/** Spec + verdict in one table cell: the spec on top, the verdict under it in
 *  smaller text. `faded` is for a superseded (retest history) row. */
export function AnalysisSpecCell({
  analysis,
  faded = false,
}: {
  analysis: Pick<SenaiteAnalysis, 'specification' | 'conforms' | 'result' | 'unit'>
  faded?: boolean
}) {
  const spec = analysis.specification
  const verdict = specVerdict(analysis)
  if (!spec || !verdict) {
    return (
      <span
        data-testid="analysis-spec-cell"
        data-spec-verdict="none"
        className="text-xs text-muted-foreground/50"
        title="No spec is filed for this analysis service"
      >
        {'–'}
      </span>
    )
  }
  const resultShown = String(analysis.result ?? '').trim()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="analysis-spec-cell"
          data-spec-verdict={verdict.tone}
          className={cn(
            'inline-flex flex-col leading-tight cursor-default',
            faded && 'opacity-60'
          )}
        >
          <span className="text-xs font-mono tabular-nums whitespace-nowrap">
            {specText(spec)}
          </span>
          <span className={cn('text-[10px] whitespace-nowrap', TONE_CLASS[verdict.tone])}>
            {verdict.label}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <div className="flex flex-col gap-1 text-xs font-mono">
          <div className="font-semibold">Specification</div>
          <div>Rule: {specText(spec)}</div>
          <div>
            Result: {resultShown ? `${resultShown}${analysis.unit && analysis.unit.toLowerCase() !== 'text' ? ` ${analysis.unit}` : ''}` : 'not entered yet'}
          </div>
          <div>Verdict: {verdict.label}</div>
          <div className="opacity-70 font-sans">
            Judged by Accu-Mk1 with the same rule the certificate uses.
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
