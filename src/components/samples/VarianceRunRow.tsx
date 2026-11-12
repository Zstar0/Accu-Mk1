import { Clock, CornerDownRight, Lock } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'
import type { VarianceRun, VarianceTest } from '@/lib/api'
import { VarianceHelp } from '@/components/samples/VarianceHelp'
import {
  VARIANCE_PILL_CAP,
  formatRunValueWithUnit,
  pillValueText,
  sharedUnit,
} from '@/lib/variance-values'

function RunHoverCard({ run, excluded }: { run: VarianceRun; excluded: boolean }) {
  const analysts = [...new Set(run.values.map(v => v.analyst).filter(Boolean))]
  return (
    <div className="flex flex-col gap-1.5 p-3 text-xs font-mono">
      <div className="font-semibold border-b border-primary-foreground/20 pb-1.5">
        {run.sample_id}
      </div>
      {excluded && (
        <div>Excluded{run.exclusion_reason ? `: ${run.exclusion_reason}` : ''}</div>
      )}
      {run.values.length === 0 && <div>No result yet</div>}
      {run.values.map(v => (
        <div key={v.keyword}>
          {v.label ?? v.keyword}: {formatRunValueWithUnit(v)}
          {v.review_state ? ` (${v.review_state.replace(/_/g, ' ')})` : ''}
        </div>
      ))}
      <div className="border-t border-primary-foreground/20 pt-1.5">
        {run.signed_off ? 'Signed off' : 'Not signed off yet'}
        {analysts.length > 0 ? ` · Analyst ${analysts.join(', ')}` : ''}
      </div>
    </div>
  )
}

function RunPill({ run, test }: { run: VarianceRun; test: VarianceTest }) {
  const excluded = !run.in_variance_set
  const pending = !run.has_result
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="variance-pill"
          data-state-kind={excluded ? 'excluded' : pending ? 'pending' : 'result'}
          onClick={e => {
            e.stopPropagation()
            useUIStore.getState().navigateToSample(run.sample_id)
          }}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap cursor-pointer hover:opacity-80',
            excluded
              ? 'border-border bg-muted text-muted-foreground line-through decoration-muted-foreground/50'
              : pending
                ? 'border-amber-500/60 text-amber-700 dark:text-amber-400'
                : 'border-border bg-muted/40 text-foreground'
          )}
        >
          <span className="font-medium">Vial {run.vial_sequence}</span>
          <span className="tabular-nums">{pending ? 'pending' : pillValueText(run, test)}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="p-0 max-w-xs">
        <RunHoverCard run={run} excluded={excluded} />
      </TooltipContent>
    </Tooltip>
  )
}

/** The parent page's read-only Variance row for one test: every replicate
 *  vial as a pill, the shared unit, and the sign-off count. Not an analysis
 *  row: no checkbox, no actions, never counted in the table's totals. */
export function VarianceRunRow({
  test,
  onOpenVariance,
}: {
  test: VarianceTest
  onOpenVariance?: () => void
}) {
  const replicates = test.runs
    .filter(r => r.kind === 'variance')
    .sort((a, b) => a.vial_sequence - b.vial_sequence)
  if (replicates.length === 0) return null
  const shown = replicates.slice(0, VARIANCE_PILL_CAP)
  const hidden = replicates.length - shown.length
  const unit = sharedUnit(test)
  const { replicates: counted, replicates_signed_off: signed } = test.summary
  const allSigned = counted > 0 && signed === counted
  return (
    <tr data-testid="variance-run-row" className="border-b border-border/50 bg-muted/10">
      <td className="py-2 px-3 text-right">
        <CornerDownRight className="inline h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      </td>
      <td colSpan={9} className="py-2 px-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300">
            Variance · {replicates.length}
            <VarianceHelp id="parent_row" />
          </span>
          {shown.map(run => (
            <RunPill key={run.sample_id} run={run} test={test} />
          ))}
          {hidden > 0 && (
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                onOpenVariance?.()
              }}
              className="text-[11px] text-muted-foreground underline underline-offset-2 cursor-pointer hover:text-foreground"
            >
              +{hidden} more
            </button>
          )}
          {unit && <span className="text-[11px] text-muted-foreground">{unit}</span>}
          <span
            data-testid="variance-signoff"
            className={cn(
              'ml-auto inline-flex items-center gap-1 text-[11px] font-medium',
              allSigned
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-amber-600 dark:text-amber-400'
            )}
          >
            {allSigned ? (
              <Lock className="h-3 w-3" aria-hidden="true" />
            ) : (
              <Clock className="h-3 w-3" aria-hidden="true" />
            )}
            {signed} of {counted} signed off
          </span>
        </div>
      </td>
    </tr>
  )
}
