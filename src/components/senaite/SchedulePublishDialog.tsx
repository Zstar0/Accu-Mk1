/**
 * Schedule Publish: pick when a finished COA goes out.
 *
 * Confirming REGENERATES the draft with the chosen lab date as its Published
 * Date and parks the publish; the backend job fires it at that time. The
 * picker is a native datetime-local in the browser's timezone; the lab date
 * the certificate will print is previewed from the lab timezone the API
 * returns. Quiet-window and lead-time rules are enforced server-side (422);
 * this dialog only surfaces them.
 */
import { useEffect, useState } from 'react'
import { CalendarClock, Loader2, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { ScheduledPublish, ScheduledPublishState } from '@/lib/api'
import {
  fmtWhen,
  labDate,
  localInputToIso,
  toLocalInputValue,
} from '@/lib/scheduled-publish'
import { cn } from '@/lib/utils'

const MIN_LEAD_MS = 30 * 60 * 1000

export function SchedulePublishDialog({
  open,
  onOpenChange,
  sampleId,
  state,
  busy,
  onSubmit,
  onRefresh,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sampleId: string
  state: ScheduledPublishState | null
  busy: boolean
  /** ISO UTC instant. */
  onSubmit: (iso: string) => void
  /** Re-fetch the state (fresh suggestion) when the dialog opens. */
  onRefresh: () => void
}) {
  // `onRefresh` is a stable useCallback in the page (keyed by sample), so
  // this fires once per open, not on every render.
  useEffect(() => {
    if (open) onRefresh()
  }, [open, onRefresh])

  // Prefill: the pending schedule if there is one, else the suggestion. The
  // form is keyed by the seed so a fresh suggestion remounts it with the new
  // value instead of a setState-in-effect.
  const seed =
    state?.schedule?.status === 'pending'
      ? state.schedule.scheduled_at
      : (state?.suggested_at ?? '')

  return (
    <Dialog open={open} onOpenChange={o => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4" />
            Schedule publish for {sampleId}
          </DialogTitle>
          <DialogDescription>
            The draft COA is regenerated now with the scheduled date as its
            Published Date, then published automatically at that time.
          </DialogDescription>
        </DialogHeader>
        {state ? (
          <ScheduleForm
            key={seed}
            seed={seed}
            state={state}
            busy={busy}
            onSubmit={onSubmit}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ScheduleForm({
  seed,
  state,
  busy,
  onSubmit,
  onClose,
}: {
  seed: string
  state: ScheduledPublishState
  busy: boolean
  onSubmit: (iso: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(() => toLocalInputValue(seed))
  // Lead-time check runs in the submit handler (the clock is impure in
  // render); the backend enforces the same rule with a 422.
  const [tooSoon, setTooSoon] = useState(false)

  const iso = localInputToIso(value)
  const tz = state.lab_timezone
  const coaDate = iso ? labDate(iso, tz) : ''
  const pastSla =
    iso && state.sla_deadline
      ? new Date(iso).getTime() > new Date(state.sla_deadline).getTime()
      : false
  const suggestionPastSla =
    !!state.sla_deadline &&
    new Date(state.suggested_at).getTime() >
      new Date(state.sla_deadline).getTime()

  const submit = () => {
    if (!iso) return
    if (new Date(iso).getTime() < Date.now() + MIN_LEAD_MS) {
      setTooSoon(true)
      return
    }
    onSubmit(iso)
  }

  return (
    <>
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="text-muted-foreground text-xs">
            Publish at (your local time)
          </span>
          <input
            type="datetime-local"
            value={value}
            onChange={e => {
              setValue(e.target.value)
              setTooSoon(false)
            }}
            disabled={busy}
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            data-testid="schedule-publish-input"
          />
        </label>

        <div className="text-xs space-y-1">
          <div>
            COA Published Date will read{' '}
            <span className="font-mono font-semibold">{coaDate || '…'}</span>{' '}
            <span className="text-muted-foreground">(lab time, {tz})</span>
          </div>
          {state.sla_deadline && (
            <div
              className={cn(pastSla ? 'text-red-400' : 'text-muted-foreground')}
            >
              SLA deadline: {fmtWhen(state.sla_deadline)}
              {state.sla_tier ? ` (${state.sla_tier} tier)` : ''}
              {pastSla ? ' · this time is AFTER the deadline' : ''}
            </div>
          )}
          {state.suggestion_clamped && (
            <div className="text-amber-400">
              {suggestionPastSla
                ? 'This sample is already past its SLA deadline; the suggestion is as soon as possible.'
                : 'Suggestion pulled in to stay inside the SLA.'}
            </div>
          )}
          {tooSoon && (
            <div className="text-red-400">
              Pick a time at least 30 minutes out. To publish now, use Publish
              Accumark COA.
            </div>
          )}
          <div className="text-muted-foreground">
            No publishing between 10pm and 5am lab time. The suggestion lands
            late in the SLA window (50 to 70 hours after receipt on the 3-day
            tier, the same share of a longer tier), skipping closed days.
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy || !iso || tooSoon}
          onClick={submit}
          data-testid="schedule-publish-submit"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CalendarClock className="h-3.5 w-3.5" />
          )}
          {state.schedule?.status === 'pending'
            ? 'Reschedule and regenerate draft'
            : 'Schedule and regenerate draft'}
        </Button>
      </DialogFooter>
    </>
  )
}

/** Header chip: "Publish scheduled Sep 19, 10:00 AM" (pending), "Publishing
 *  now" (firing) or a red "Scheduled publish failed" with the error on hover.
 *  The X cancels a pending schedule or dismisses a failed one. */
export function ScheduledPublishBadge({
  schedule,
  busy,
  onCancel,
}: {
  schedule: ScheduledPublish
  busy: boolean
  onCancel: () => void
}) {
  const failed = schedule.status === 'failed'
  const firing = schedule.status === 'firing'
  const label = failed
    ? 'Scheduled publish failed'
    : firing
      ? 'Publishing now'
      : `Publish scheduled ${fmtWhen(schedule.scheduled_at)}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn(
            'gap-1 pr-1',
            failed
              ? 'border-red-500/50 text-red-400'
              : 'border-sky-500/50 text-sky-400'
          )}
          data-testid="scheduled-publish-badge"
          data-status={schedule.status}
        >
          <CalendarClock className="h-3 w-3" />
          {label}
          {!firing && (
            <button
              type="button"
              className="ml-0.5 rounded-sm hover:bg-muted/60 disabled:opacity-50"
              onClick={onCancel}
              disabled={busy}
              aria-label={failed ? 'Dismiss' : 'Cancel scheduled publish'}
              data-testid="scheduled-publish-cancel"
            >
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <X className="h-3 w-3" />
              )}
            </button>
          )}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs text-xs space-y-0.5">
        <div>COA Published Date: {schedule.pdf_date}</div>
        {failed && schedule.last_error && (
          <div className="text-red-300">{schedule.last_error}</div>
        )}
        {failed ? (
          <div className="text-muted-foreground">
            Not retried automatically. Fix the cause, then Publish, or dismiss.
          </div>
        ) : firing ? (
          <div className="text-muted-foreground">
            The scheduler is publishing this sample right now.
          </div>
        ) : (
          <div className="text-muted-foreground">
            Publishing this sample by hand cancels the schedule.
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
