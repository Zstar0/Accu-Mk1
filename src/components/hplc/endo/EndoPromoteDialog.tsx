import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  promoteWorksheetRows,
  type EndoPromoteRowIn,
  type EndoPromoteRowResult,
} from '@/lib/api'
import type { EndoRow } from '@/lib/endo-worksheet-2ml'
import { labelFor } from '@/lib/workflow-states-store'
import { TH } from '@/components/hplc/EndoWorksheetTable'
import { STATE_LABELS } from '@/components/senaite/senaite-utils'

/** A ticked, eligible Box 3 row: what is sent, and its verdict as Box 3
 *  words and colours it. */
export interface PromotePick {
  row: EndoRow
  payload: EndoPromoteRowIn
  verdict: { label: string; tone: string }
}

const PCELL = 'border-b border-border/60 px-2 py-1.5 align-top'

function Outcome({ result }: { result: EndoPromoteRowResult | undefined }) {
  if (!result)
    return <span className="text-muted-foreground">no reply for this row</span>
  if (!result.promoted)
    return (
      <span className="text-red-600 dark:text-red-400">
        Not promoted: {result.reason}
      </span>
    )
  const state = result.state
  return (
    <span className="text-emerald-700 dark:text-emerald-300">
      Promoted
      {state
        ? `: parent result ${labelFor(state, STATE_LABELS[state]?.label ?? state, 'analysis')}`
        : ''}
    </span>
  )
}

/**
 * Box 3's Promote to Parent (spec 5.1): the button, a confirm listing each
 * ticked row with exactly what is sent, one request, then each row's
 * outcome. The list is the picks as they were when it opened, so the
 * refresh after a promote never rewrites it under its results.
 */
export function EndoPromoteDialog({
  worksheetId,
  picks,
  onSettled,
}: {
  worksheetId: number
  /** The ticked rows that are eligible now, in Box 3 order. */
  picks: PromotePick[]
  /** After the server replied (true) or the request failed (false). */
  onSettled: (replied: boolean) => void
}) {
  const [listed, setListed] = useState<PromotePick[] | null>(null)
  const [results, setResults] = useState<Map<
    number,
    EndoPromoteRowResult
  > | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function close() {
    setListed(null)
    setResults(null)
    setError(null)
  }

  async function send() {
    if (!listed?.length || sending) return
    setSending(true)
    setError(null)
    try {
      const res = await promoteWorksheetRows(
        worksheetId,
        listed.map(p => p.payload)
      )
      setResults(new Map(res.results.map(r => [r.item_id, r])))
      onSettled(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Promote failed')
      onSettled(false)
    } finally {
      setSending(false)
    }
  }

  const done = results
    ? [...results.values()].filter(r => r.promoted).length
    : 0

  return (
    <>
      <Button
        size="sm"
        className="shrink-0"
        disabled={!picks.length}
        onClick={() => setListed(picks)}
      >
        Promote to Parent ({picks.length})
      </Button>
      <Dialog
        open={listed !== null}
        onOpenChange={open => {
          if (!open && !sending) close()
        }}
      >
        {listed && (
          <DialogContent className="flex max-h-[88vh] w-[820px] max-w-[96vw] flex-col gap-3 sm:max-w-[96vw]">
            <DialogTitle className="text-sm font-semibold">
              Promote to Parent
            </DialogTitle>
            <DialogDescription className="text-xs">
              {results
                ? `${done} of ${listed.length} promoted. A reviewer verifies each parent result on its sample page.`
                : "Fills each vial's endotoxin result with these values and promotes it to its parent sample, where a reviewer verifies it. A < result is sent as its LOQ; the COA prints it as < and the LOQ, for example < 25."}
            </DialogDescription>
            <div className="min-h-0 overflow-auto">
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr>
                    <th className={TH}>Row</th>
                    <th className={TH}>Sample ID</th>
                    <th className={`${TH} !text-right`}>Value</th>
                    <th className={`${TH} !text-right`}>LOQ</th>
                    <th className={`${TH} !text-right`}>LOD</th>
                    <th className={TH}>Verdict</th>
                    {results && <th className={TH}>Result</th>}
                  </tr>
                </thead>
                <tbody>
                  {listed.map(({ row, payload, verdict }) => (
                    <tr key={payload.item_id}>
                      <td
                        className={`${PCELL} font-mono text-muted-foreground`}
                      >
                        {row.n}
                      </td>
                      <td className={`${PCELL} font-mono`}>
                        {row.item.sample_id}
                      </td>
                      <td className={`${PCELL} text-right font-mono`}>
                        {payload.value} {payload.unit}
                      </td>
                      <td className={`${PCELL} text-right font-mono`}>
                        {payload.loq} {payload.unit}
                      </td>
                      <td className={`${PCELL} text-right font-mono`}>
                        {payload.lod} {payload.lod_unit}
                      </td>
                      <td className={`${PCELL} font-semibold ${verdict.tone}`}>
                        {verdict.label}
                      </td>
                      {results && (
                        <td className={PCELL}>
                          <Outcome result={results.get(payload.item_id)} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {error && (
              <p
                role="alert"
                className="text-xs text-red-600 dark:text-red-400"
              >
                {error}
              </p>
            )}
            <div className="flex items-center gap-2 border-t pt-3">
              {results ? (
                <Button size="sm" onClick={close}>
                  Done
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    disabled={sending}
                    onClick={() => void send()}
                  >
                    Promote {listed.length}{' '}
                    {listed.length === 1 ? 'result' : 'results'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={sending}
                    onClick={close}
                  >
                    Cancel
                  </Button>
                </>
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}

export default EndoPromoteDialog
