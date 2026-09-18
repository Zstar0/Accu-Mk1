/**
 * Scheduled Publishes: every COA parked for a future publish, in one list.
 *
 * Live rows first (publishing now, then pending soonest first, then failed);
 * "Show history" adds what already settled. The trash button removes a
 * schedule through the same per-sample route the Sample Details badge uses:
 * a pending row's draft is regenerated with today's date (so a future-dated
 * certificate can never ship by a later manual publish), a failed row is
 * just dismissed.
 */
import { useState } from 'react'
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { CalendarClock, Loader2, Trash2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import {
  cancelScheduledPublish,
  getScheduledPublishes,
  type ScheduledPublishRow,
} from '@/lib/api'
import { fmtWhen, untilText } from '@/lib/scheduled-publish'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

const LIST_KEY = ['reports', 'scheduled-publishes'] as const

const STATUS_STYLE: Record<ScheduledPublishRow['status'], string> = {
  pending: 'border-sky-500/50 text-sky-400',
  firing: 'border-amber-500/50 text-amber-400',
  failed: 'border-red-500/50 text-red-400',
  published: 'border-emerald-500/40 text-emerald-400',
  cancelled: 'text-muted-foreground',
}
const STATUS_LABEL: Record<ScheduledPublishRow['status'], string> = {
  pending: 'Scheduled',
  firing: 'Publishing now',
  failed: 'Failed',
  published: 'Published',
  cancelled: 'Cancelled',
}

export function ScheduledPublishesReport() {
  const [showHistory, setShowHistory] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const navigateToSample = useUIStore(state => state.navigateToSample)
  const qc = useQueryClient()

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: [...LIST_KEY, { showHistory }],
    queryFn: () => getScheduledPublishes({ includeHistory: showHistory }),
    staleTime: 15_000,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  })

  const onRemove = async (row: ScheduledPublishRow) => {
    const pending = row.status === 'pending'
    const ok = window.confirm(
      pending
        ? `Remove the publish scheduled for ${row.sample_id} (${fmtWhen(row.scheduled_at)})?\n\n` +
            `The draft COA is regenerated with today's date, which can take a minute.`
        : `Dismiss the failed scheduled publish for ${row.sample_id}?`
    )
    if (!ok) return
    setBusyId(row.sample_id)
    try {
      const result = await cancelScheduledPublish(row.sample_id)
      if (result.success) {
        toast.success(pending ? 'Schedule removed' : 'Dismissed', {
          description: result.message,
        })
      } else {
        toast.error('Remove schedule', { description: result.message })
      }
    } catch (err) {
      toast.error('Remove schedule', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setBusyId(null)
      await qc.invalidateQueries({ queryKey: LIST_KEY })
      // The Ready to Publish page parks scheduled rows; keep it in step.
      await qc.invalidateQueries({ queryKey: ['reports', 'ready-to-publish'] })
    }
  }

  const rows = data?.rows ?? []
  const totals = data?.totals

  return (
    <div className="flex flex-col gap-4 p-6" data-testid="scheduled-publishes">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <CalendarClock className="h-5 w-5" />
            Scheduled Publishes
          </h1>
          <p className="text-sm text-muted-foreground">
            COAs parked for a future publish. They go out automatically at the
            scheduled time (never between 10pm and 5am lab time).
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <label className="flex items-center gap-2 cursor-pointer">
            <Switch
              checked={showHistory}
              onCheckedChange={setShowHistory}
              data-testid="sp-history-toggle"
            />
            Show history
          </label>
          {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        </div>
      </div>

      {totals && (
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant="outline" className={STATUS_STYLE.pending}>
            {totals.pending} scheduled
          </Badge>
          {totals.firing > 0 && (
            <Badge variant="outline" className={STATUS_STYLE.firing}>
              {totals.firing} publishing now
            </Badge>
          )}
          <Badge
            variant="outline"
            className={cn(totals.failed > 0 && STATUS_STYLE.failed)}
          >
            {totals.failed} failed
          </Badge>
          {showHistory && (
            <>
              <Badge variant="outline" className={STATUS_STYLE.published}>
                {totals.published} published
              </Badge>
              <Badge variant="outline" className="text-muted-foreground">
                {totals.cancelled} cancelled
              </Badge>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <XCircle className="h-4 w-4" />
          {(error as Error).message}
        </div>
      )}
      {isLoading && !data && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}
      {data && rows.length === 0 && (
        <div className="text-sm text-muted-foreground py-8 text-center">
          Nothing is scheduled. Use Actions, Schedule publish on a sample to
          park its COA.
        </div>
      )}

      {rows.length > 0 && data && (
        <div className="rounded-md border border-border/60 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-2 pl-3 pr-2 text-left font-medium">Sample</th>
                <th className="py-2 pr-2 text-left font-medium">Customer</th>
                <th className="py-2 pr-2 text-left font-medium">Publishes</th>
                <th className="py-2 pr-2 text-left font-medium">COA date</th>
                <th className="py-2 pr-2 text-left font-medium">Status</th>
                <th className="py-2 pr-2 text-left font-medium">
                  Scheduled by
                </th>
                <th className="py-2 pr-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <Line
                  key={row.id}
                  row={row}
                  generatedAt={data.generated_at}
                  busy={busyId === row.sample_id}
                  onOpen={navigateToSample}
                  onRemove={onRemove}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Line({
  row,
  generatedAt,
  busy,
  onOpen,
  onRemove,
}: {
  row: ScheduledPublishRow
  generatedAt: string
  busy: boolean
  onOpen: (id: string) => void
  onRemove: (row: ScheduledPublishRow) => void
}) {
  const live = row.status === 'pending' || row.status === 'failed'
  const settled = row.status === 'published' || row.status === 'cancelled'
  return (
    <tr
      className={cn(
        'border-b border-border/40 hover:bg-muted/30 cursor-pointer',
        settled && 'opacity-70'
      )}
      data-testid="sp-row"
      data-sample-id={row.sample_id}
      data-status={row.status}
      onClick={() => onOpen(row.sample_id)}
    >
      <td className="py-1.5 pl-3 pr-2 align-top">
        <div className="font-mono text-sm text-primary">{row.sample_id}</div>
        <div className="text-[11px] text-muted-foreground tabular-nums">
          Order {row.order || '?'}
        </div>
      </td>
      <td className="py-1.5 pr-2 align-top text-xs">
        {row.client ?? <span className="text-muted-foreground/50">?</span>}
        {row.received_at && (
          <div className="text-[11px] text-muted-foreground">
            Received {fmtWhen(row.received_at)}
          </div>
        )}
      </td>
      <td className="py-1.5 pr-2 align-top text-xs tabular-nums whitespace-nowrap">
        {fmtWhen(row.scheduled_at)}
        {row.status === 'pending' && (
          <div className="text-[11px] text-muted-foreground">
            {untilText(row.scheduled_at, generatedAt)}
          </div>
        )}
      </td>
      <td className="py-1.5 pr-2 align-top text-xs font-mono">
        {row.pdf_date}
      </td>
      <td className="py-1.5 pr-2 align-top">
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className={cn('text-[10px]', STATUS_STYLE[row.status])}
              data-testid="sp-status"
            >
              {STATUS_LABEL[row.status]}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-xs space-y-0.5">
            {row.last_error && <div>{row.last_error}</div>}
            {row.fired_at && <div>Fired {fmtWhen(row.fired_at)}</div>}
            {row.cancelled_at && (
              <div>Cancelled {fmtWhen(row.cancelled_at)}</div>
            )}
            {row.status === 'failed' && (
              <div className="text-muted-foreground">
                Not retried automatically. Fix the cause, then publish from the
                sample, or dismiss.
              </div>
            )}
            {row.status === 'pending' && (
              <div className="text-muted-foreground">
                Fires on the first scheduler tick at or after this time.
              </div>
            )}
          </TooltipContent>
        </Tooltip>
      </td>
      <td className="py-1.5 pr-2 align-top text-xs">
        {row.created_by ?? <span className="text-muted-foreground/50">?</span>}
        <div className="text-[11px] text-muted-foreground">
          {fmtWhen(row.created_at)}
        </div>
      </td>
      <td className="py-1.5 pr-3 align-top text-right whitespace-nowrap">
        {live && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                disabled={busy}
                aria-label={
                  row.status === 'pending'
                    ? `Remove the scheduled publish for ${row.sample_id}`
                    : `Dismiss the failed scheduled publish for ${row.sample_id}`
                }
                onClick={e => {
                  e.stopPropagation()
                  onRemove(row)
                }}
                data-testid="sp-remove"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs text-xs">
              {row.status === 'pending'
                ? "Remove this schedule. The draft COA is regenerated with today's date."
                : 'Dismiss this failed schedule.'}
            </TooltipContent>
          </Tooltip>
        )}
      </td>
    </tr>
  )
}
