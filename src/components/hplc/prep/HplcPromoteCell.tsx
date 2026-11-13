import { useEffect, useId, useRef, useState } from 'react'
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
import type { HplcRowComputed } from '@/lib/hplc-prep'
import { useUIStore } from '@/store/ui-store'
import type { SheetRowView } from './HplcPrepSheet'
import { fmtDp } from './HplcSheetCells'
import { VIAL_LETTERS } from './hplc-sheet-columns'

const CONFIRM =
  'Promote this row? Its prep becomes final and can only be corrected by a retest.'

const STILL_SAVING = 'Still saving. Press Promote again when it has finished.'

const messageOf = (e: unknown) =>
  e instanceof Error ? e.message : 'something went wrong; try again'

/** What a press found: the reasons, and the row worked out from the
 *  server's values (null when it cannot be planned). */
export interface PromoteCheck {
  reasons: string[]
  computed: HplcRowComputed | null
}

/** What the prep will record, for the confirm: each vial's target and the
 *  diluent, as worked out from the server's values. */
function planLines(computed: HplcRowComputed | null): string[] {
  if (!computed) return []
  const many = computed.vials.length > 1
  return [
    ...computed.vials.map(
      v =>
        `${many ? `Vial ${VIAL_LETTERS[v.vial - 1] ?? v.vial}: ` : ''}Target Conc ${fmtDp(v.target.value, 0)} ug/mL`
    ),
    ...(computed.diluent.diluent
      ? [`Diluent ${computed.diluent.diluent}`]
      : []),
  ]
}

/**
 * Step 2's last column, "Sample prep". A promoted row: its prep's number,
 * which opens Sample Preps, and a "final" badge. Otherwise Promote, off with
 * its reasons in a tooltip while the row is not ready or a save is pending.
 * A press reads the sheet and the rules again first (`check`); a row still
 * ready is asked about once, focus on Cancel, then promoted. The server's
 * refusal reasons are shown under the button as returned, and stay (in the
 * next confirm too) until a new answer replaces them; a press's own reasons
 * go when a later press finds the row ready. When the confirm closes, focus
 * goes back to Promote, or to the prep link once the row is final.
 */
export function HplcPromoteCell({
  view,
  reasons,
  unsaved = null,
  saving,
  othersPressing = false,
  onRunning,
  check,
  promote,
}: {
  view: SheetRowView
  /** Why the row cannot be promoted, as the screen has it (empty: ready). */
  reasons: string[]
  /** The sentence for a save of this row that did not land and is still on
   *  the page's list (null: none): a press is refused with it. */
  unsaved?: string | null
  /** A save on the sheet is pending. */
  saving: boolean
  /** Another row's press is running: this one is off meanwhile. */
  othersPressing?: boolean
  /** This row's press started (true) or ended (false). */
  onRunning?: (itemId: number, on: boolean) => void
  /** The press's read-again: 'saving' when a save went out before or during
   *  it, null when there is nothing to ask (the row is already final). */
  check: () => Promise<PromoteCheck | 'saving' | null>
  promote: () => Promise<unknown>
}) {
  const { row } = view
  const itemId = row.item_id
  // the press's own reasons, and the server's last refusal (kept until a
  // new answer replaces it)
  const [own, setOwn] = useState<string[] | null>(null)
  const [server, setServer] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [asking, setAsking] = useState<PromoteCheck | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLElement | null>(null)
  const toRoot = (el: HTMLElement | null) => {
    rootRef.current = el
  }
  const reasonsId = useId()

  // a press runs from the click until the confirm closes and the request
  // has answered
  const running = busy !== null || asking !== null
  useEffect(() => {
    onRunning?.(itemId, running)
    return () => onRunning?.(itemId, false)
  }, [onRunning, itemId, running])

  // Where focus goes once the confirm has closed: 'cell' is Promote (or
  // its wrapper while it is off), 'link' the prep link once the row is
  // final. It waits until that control can take focus.
  const refocus = useRef<'cell' | 'link' | null>(null)
  const putFocusBack = () => {
    const want = refocus.current
    if (!want || (want === 'link' && !row.promoted)) return
    const to = rootRef.current?.querySelector<HTMLElement>(
      'button:not(:disabled), [tabindex="0"]'
    )
    if (!to) return
    refocus.current = null
    to.focus()
  }
  useEffect(() => {
    // only when focus was lost to the page, never away from a box
    const at = document.activeElement
    if (!at || at === document.body) putFocusBack()
  })

  if (row.promoted)
    return (
      <span
        ref={toRoot}
        className="flex items-center gap-1.5 whitespace-nowrap"
      >
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
    // a box of this row whose save did not land: its old value would be
    // filed, so the press stops before it reads anything
    if (unsaved) {
      setOwn([unsaved])
      return
    }
    setBusy('Checking...')
    try {
      const fresh = await check()
      if (fresh === 'saving') setOwn([STILL_SAVING])
      else if (fresh?.reasons.length) setOwn(fresh.reasons)
      else if (fresh) {
        // ready: the last press's own reasons are out of date
        setOwn(null)
        setAsking(fresh)
      }
    } catch (e) {
      setOwn([`could not read the sheet again: ${messageOf(e)}`])
    } finally {
      setBusy(null)
    }
  }

  /** The confirm closed without promoting: focus back on Promote. */
  function cancel() {
    refocus.current = 'cell'
    setAsking(null)
  }

  async function confirm() {
    refocus.current = 'cell'
    setAsking(null)
    setBusy('Promoting...')
    try {
      await promote()
      setOwn(null)
      setServer(null)
      refocus.current = 'link'
    } catch (e) {
      if (e instanceof HplcPromoteRefused && e.reasons.length) {
        setOwn(null)
        setServer(e.reasons)
      } else setOwn([messageOf(e)])
    } finally {
      setBusy(null)
    }
  }

  const said = [...(own ?? []), ...(server ?? [])]
  const off = saving || busy !== null || reasons.length > 0 || othersPressing
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
  const lastRefusal = server
  const plan = asking ? planLines(asking.computed) : []
  return (
    <div ref={toRoot} className="min-w-[7rem] max-w-[22rem] whitespace-normal">
      {reasons.length && !saving && !busy ? (
        // a disabled button fires no hover: the wrapper carries the tooltip,
        // and a hidden copy of the reasons describes it for a screen reader
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className="inline-block"
                aria-describedby={reasonsId}
              >
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
          <span id={reasonsId} className="sr-only">
            Not ready to promote: {reasons.join('; ')}
          </span>
        </>
      ) : (
        button
      )}
      {said.length > 0 && (
        // the role on a wrapper, so the list keeps its own
        <div role="alert">
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] leading-snug text-red-700 dark:text-red-300">
            {said.map(r => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <Dialog
        open={asking !== null}
        onOpenChange={open => {
          if (!open) cancel()
        }}
      >
        <DialogContent
          className="max-w-md"
          // Promote is final: start on Cancel, so Enter never promotes
          onOpenAutoFocus={e => {
            e.preventDefault()
            cancelRef.current?.focus()
          }}
          // no trigger to go back to: focus goes to this row's control, not
          // the page body (or later, once it can take it)
          onCloseAutoFocus={e => {
            e.preventDefault()
            putFocusBack()
          }}
        >
          <DialogTitle className="text-sm font-semibold">
            Promote {row.sample_id}
          </DialogTitle>
          <DialogDescription className="text-sm">{CONFIRM}</DialogDescription>
          {plan.length > 0 && (
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {plan.map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          {lastRefusal && (
            <div className="text-xs text-red-700 dark:text-red-300">
              <p>Last time the server said:</p>
              <ul className="list-disc space-y-0.5 pl-4">
                {lastRefusal.map(r => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex items-center gap-2 border-t pt-3">
            <Button size="sm" onClick={() => void confirm()}>
              Promote
            </Button>
            <Button
              ref={cancelRef}
              size="sm"
              variant="outline"
              onClick={cancel}
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
