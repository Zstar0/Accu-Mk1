import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { HplcPromoteRefused } from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import type { SheetRowView } from './HplcPrepSheet'

const CONFIRM =
  'Promote this row? Its prep becomes final and can only be corrected by a retest.'

const messageOf = (e: unknown) =>
  e instanceof Error ? e.message : 'something went wrong; try again'

/**
 * Step 2's last column, "Sample prep". A promoted row: its prep's number,
 * which opens Sample Preps, and a "final" badge. Otherwise Promote, off with
 * its reasons in a tooltip while the row is not ready or a save is pending.
 * A press reads the sheet again first (`check`, the reasons from the
 * server's values); a row still ready is asked about once, then promoted.
 * The server's refusal reasons are shown under the button as returned.
 */
export function HplcPromoteCell({
  view,
  reasons,
  saving,
  check,
  promote,
}: {
  view: SheetRowView
  /** Why the row cannot be promoted, as the screen has it (empty: ready). */
  reasons: string[]
  /** A save on the sheet is pending. */
  saving: boolean
  /** The reasons from the sheet read again; null when there is nothing to
   *  ask (a save went out meanwhile, or the row is already final). */
  check: () => Promise<string[] | null>
  promote: () => Promise<unknown>
}) {
  const { row } = view
  const [said, setSaid] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)

  if (row.promoted)
    return (
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        {row.prep ? (
          <button
            type="button"
            className="font-mono text-[12.5px] text-teal-700 underline-offset-2 hover:underline dark:text-teal-300"
            title="Open Sample Preps"
            onClick={() =>
              useUIStore.getState().navigateTo('hplc-analysis', 'sample-preps')
            }
          >
            {row.prep.sample_id}
          </button>
        ) : (
          <span className="text-muted-foreground">promoted</span>
        )}
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          final
        </Badge>
      </span>
    )

  async function press() {
    setSaid(null)
    setBusy('Checking...')
    try {
      const fresh = await check()
      if (fresh?.length) setSaid(fresh)
      else if (fresh) setAsking(true)
    } catch (e) {
      setSaid([`could not read the sheet again: ${messageOf(e)}`])
    } finally {
      setBusy(null)
    }
  }

  async function confirm() {
    setAsking(false)
    setBusy('Promoting...')
    try {
      await promote()
    } catch (e) {
      setSaid(
        e instanceof HplcPromoteRefused && e.reasons.length
          ? e.reasons
          : [messageOf(e)]
      )
    } finally {
      setBusy(null)
    }
  }

  const off = saving || busy !== null || reasons.length > 0
  const button = (
    <Button
      size="sm"
      variant="outline"
      className="h-7 px-2.5 text-xs"
      disabled={off}
      onClick={() => void press()}
    >
      {busy ?? (saving ? 'Saving...' : 'Promote')}
    </Button>
  )
  return (
    <div className="min-w-[7rem] max-w-[22rem] whitespace-normal">
      {reasons.length && !saving && !busy ? (
        // a disabled button fires no hover: the wrapper carries the tooltip
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-block">
              {button}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">
            <p className="pb-1 font-semibold">Not ready to promote:</p>
            <ul className="list-disc space-y-0.5 pl-4">
              {reasons.map(r => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
      {said && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] leading-snug text-red-700 dark:text-red-300">
          {said.map(r => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent className="max-w-md">
          <DialogTitle className="text-sm font-semibold">
            Promote {row.sample_id}
          </DialogTitle>
          <DialogDescription className="text-sm">{CONFIRM}</DialogDescription>
          <div className="flex items-center gap-2 border-t pt-3">
            <Button size="sm" onClick={() => void confirm()}>
              Promote
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAsking(false)}
            >
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default HplcPromoteCell
