import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import type {
  ConsumableType,
  PrepRulesReapplyCandidate,
  PrepRulesReapplyResult,
  WorksheetItemPatch,
  WorksheetListItem,
} from '@/lib/api'
import { fmt } from '@/lib/endo-prep'
import {
  dilutionPlan,
  fmtEu,
  prep2Check,
  prep2Result,
  type EndoCtx,
  type EndoSample,
} from '@/lib/endo-prep-2ml'
import {
  ruleTag,
  ruleText,
  type EndoPrepRule,
  type PrepHistoryEntry,
  type PrepRuleLock,
} from '@/lib/endo-prep-rules'
import {
  cartridgeLabel,
  endoRowUnderRule,
  type EndoCartridgeOption,
  type EndoRow,
} from '@/lib/endo-worksheet-2ml'
import { TH } from '@/components/hplc/EndoWorksheetTable'
import { WorkedTip } from './EndoWorkedTip'
import { VERDICT_LABEL } from './EndoResultsBox'

/*
 * Slice 5's pieces of Box 2 (spec 9): the rule tags with their hover, the
 * "no rule" switch and its note, a row's past runs, and Re-apply. Pure
 * presentation: the page owns the reads and the writes.
 */

const TAG =
  'inline-block rounded border px-1 py-px font-sans text-[10px] font-semibold leading-tight'
const TAG_TONE = {
  validated:
    'border-teal-500/40 bg-teal-500/10 text-teal-700 dark:border-teal-400/45 dark:bg-teal-400/15 dark:text-teal-300',
  trial:
    'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:border-amber-400/45 dark:bg-amber-400/15 dark:text-amber-300',
  locked:
    'border-slate-500/35 bg-slate-500/10 text-slate-700 dark:border-slate-400/40 dark:bg-slate-400/15 dark:text-slate-300',
  special:
    'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:border-violet-400/45 dark:bg-violet-400/15 dark:text-violet-300',
} as const

const LOCK_EVENT: Record<PrepRuleLock['locked_by'], string> = {
  print: 'print',
  result: 'its first result',
  complete: 'completion',
  reapply: 'Re-apply',
  switch: 'switching rules back on',
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

/** A lock's line with its status ("... · 1:300 total (trial)"), or "the
 *  standard" when it holds none: History and Re-apply both read it so. */
function lineLabel(
  rule: EndoPrepRule | null | undefined,
  identity: string,
  cartridges: EndoCartridgeOption[]
): string {
  return rule
    ? `${ruleText(rule, identity, cartridgeLabel(cartridges))} (${rule.status})`
    : 'the standard'
}

/** The hover on a ruled row's tags: the line, its status, its note and
 *  the lock event. */
function ruleTip(
  rule: EndoPrepRule,
  lock: PrepRuleLock | null,
  identity: string,
  cartridges: EndoCartridgeOption[]
): string {
  return [
    ruleText(rule, identity, cartridgeLabel(cartridges)),
    `Status: ${rule.status} (a label only; the maths is the same)`,
    rule.note ? `Note: ${rule.note}` : null,
    lock
      ? `Locked at ${LOCK_EVENT[lock.locked_by]}, ${when(lock.locked_at)}: later edits to the rule do not reach this row`
      : 'Not locked: it follows edits to the rule until print, a result or completion',
  ]
    .filter(Boolean)
    .join('\n')
}

/** "rule" or amber "rule (trial)", "locked" once locked, or "special prep"
 *  on a "no rule" row; nothing on a row no rule reaches. */
export function RuleTags({
  row,
  cartridges,
}: {
  row: EndoRow
  cartridges: EndoCartridgeOption[]
}) {
  const { item, sample } = row
  if (item.prep_rules_off)
    return (
      <span className="mt-1 flex flex-wrap gap-1">
        <WorkedTip
          tip={`No rule: a special preparation, typed by hand.\n${item.prep_note ? `Note: ${item.prep_note}` : 'No note'}`}
          className={`${TAG} ${TAG_TONE.special}`}
        >
          special prep
        </WorkedTip>
      </span>
    )
  const rule = sample.rule ?? null
  if (!rule) return null
  const lock = item.prep_rule ?? null
  const tip = ruleTip(rule, lock, sample.identity, cartridges)
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      <WorkedTip tip={tip} className={`${TAG} ${TAG_TONE[rule.status]}`}>
        {ruleTag(rule)}
      </WorkedTip>
      {lock && (
        <WorkedTip tip={tip} className={`${TAG} ${TAG_TONE.locked}`}>
          locked
        </WorkedTip>
      )}
    </span>
  )
}

/** The row editor's "no rule" switch and, while it is on, the optional
 *  special-prep note (spec 8), saved through the item PATCH. */
export function NoRuleEditor({
  row,
  onSend,
}: {
  row: EndoRow
  onSend: (data: WorksheetItemPatch) => void
}) {
  const { item } = row
  const off = item.prep_rules_off === true
  return (
    <div className="mt-1.5 flex flex-col items-start gap-1">
      <label className="inline-flex items-center gap-1.5 font-sans text-[11px] text-muted-foreground">
        <Switch
          aria-label="No rule (special prep)"
          checked={off}
          onCheckedChange={v => onSend({ prep_rules_off: v })}
          className="scale-75"
        />
        no rule
      </label>
      {off && (
        <input
          key={item.prep_note ?? ''}
          aria-label="Special prep note"
          placeholder="why (optional)"
          defaultValue={item.prep_note ?? ''}
          onBlur={e => {
            const note = e.target.value.trim() || null
            if (note !== (item.prep_note ?? null)) onSend({ prep_note: note })
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          className="h-6 w-full rounded-[3px] border bg-transparent px-1.5 font-sans text-[11px] focus:border-teal-500 focus:outline-none dark:focus:border-teal-400"
        />
      )}
    </div>
  )
}

/** A cartridge's sensitivity from the whole catalog, retired types too, so
 *  a past run on a retired cartridge still works out. */
function lambdaOf(
  id: number | null,
  row: EndoRow,
  cartridges: EndoCartridgeOption[],
  catalog: ConsumableType[]
): number | null {
  if (id === null) return row.inherited?.sensitivity ?? null
  const fromCatalog = catalog.find(c => c.id === id)?.specs.sensitivity_eu_ml
  if (fromCatalog != null) return Number(fromCatalog)
  const allowed = cartridges.find(c => c.id === id)?.sensitivity_eu_ml
  if (allowed != null) return allowed
  return id === row.item.cartridge_type_id
    ? (row.item.cartridge_sensitivity_eu_ml ?? null)
    : null
}

/** A past run as the maths reads it: its stored total, step 1 ratio,
 *  cartridge and reading, on the row's weight, water and step volumes. */
function pastRunSample(
  row: EndoRow,
  e: PrepHistoryEntry,
  lambda: number | null
): EndoSample {
  const s = row.sample
  return {
    ...s,
    rule: null,
    totalDilution: e.total_dilution,
    steps: [
      { sampleUl: s.steps?.[0]?.sampleUl ?? null, ratio: e.step1_ratio },
      s.steps?.[1] ?? null,
      s.steps?.[2] ?? null,
    ],
    lambda,
    reading: e.result_reading,
    reader: null,
  }
}

const HCELL = 'border-b border-border/60 px-2 py-1.5 align-top'

/** "History (n)": the row's past runs (spec 7), each one's EU per vial and
 *  verdict worked out again from what was stored, with today's maths. */
export function PrepHistory({
  row,
  ctx,
  cartridges,
  catalog,
}: {
  row: EndoRow
  ctx: EndoCtx
  cartridges: EndoCartridgeOption[]
  catalog: ConsumableType[]
}) {
  const [open, setOpen] = useState(false)
  const entries = row.item.prep_history ?? []
  if (!entries.length) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 block font-sans text-[11px] font-semibold text-teal-700 underline-offset-2 hover:underline dark:text-teal-300"
      >
        History ({entries.length})
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[88vh] w-[860px] max-w-[96vw] flex-col gap-3 sm:max-w-[96vw]">
          <DialogTitle className="text-sm font-semibold">
            {row.item.sample_id}: past runs
          </DialogTitle>
          <DialogDescription className="text-xs">
            Each run as it was stored when it was replaced, newest first. EU per
            vial and the verdict are worked out again from those values; the
            validity checks of the reader are not shown for a past run.
          </DialogDescription>
          <div className="min-h-0 overflow-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr>
                  <th className={TH}>Replaced</th>
                  <th className={TH}>Why</th>
                  <th className={TH}>Rule</th>
                  <th className={`${TH} !text-right`}>Total</th>
                  <th className={`${TH} !text-right`}>Step 1</th>
                  <th className={`${TH} !text-right`}>Cartridge</th>
                  <th className={`${TH} !text-right`}>Reading</th>
                  <th className={`${TH} !text-right`}>EU/vial</th>
                  <th className={TH}>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {[...entries].reverse().map(e => {
                  const lambda = lambdaOf(
                    e.cartridge_type_id,
                    row,
                    cartridges,
                    catalog
                  )
                  const rs = prep2Result(pastRunSample(row, e, lambda), ctx)
                  return (
                    <tr key={`${e.at}-${e.why}`}>
                      <td className={`${HCELL} whitespace-nowrap`}>
                        {when(e.at)}
                      </td>
                      <td className={HCELL}>
                        {e.why === 'reapply'
                          ? e.reading_moved
                            ? 'Re-apply (reading moved)'
                            : 'Re-apply'
                          : e.why === 'replaced'
                            ? 'Reading replaced'
                            : 'override'}
                      </td>
                      <td className={HCELL}>
                        {lineLabel(
                          e.lock?.rule,
                          row.sample.identity,
                          cartridges
                        )}
                      </td>
                      <td className={`${HCELL} text-right font-mono`}>
                        1:{fmt(e.total_dilution)}
                      </td>
                      <td className={`${HCELL} text-right font-mono`}>
                        1:{fmt(e.step1_ratio)}
                      </td>
                      <td className={`${HCELL} text-right font-mono`}>
                        {fmt(lambda) || '-'}
                      </td>
                      <td className={`${HCELL} text-right font-mono`}>
                        {e.result_reading ?? '-'}
                      </td>
                      <td className={`${HCELL} text-right font-mono`}>
                        {fmtEu(rs.lt === true, rs.euPerVial) || '-'}
                      </td>
                      <td className={HCELL}>
                        {rs.verdict ? VERDICT_LABEL[rs.verdict] : '-'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

const FIGURES = ['Total', 'Step 1', 'Cartridge', 'LOQ', 'EU/vial', 'Verdict']
/** Where the figures worked out from the reading start. */
const FROM_READING = FIGURES.indexOf('EU/vial')

/** Re-apply moves a row's reading to its history and clears it (final
 *  review I2), so such a row starts unticked. A row the page does not hold
 *  yet cannot say, so it starts unticked too. */
function hasReading(row: EndoRow | undefined): boolean {
  return (
    !row ||
    row.item.result_reading != null ||
    row.item.result_entered_at != null
  )
}

/** Old against new, as Box 2 and Box 3 would show them; dashes for a row
 *  the page does not hold yet. */
function figures(row: EndoRow | undefined, ctx: EndoCtx): string[] {
  if (!row) return FIGURES.map(() => '-')
  const plan = dilutionPlan(row.sample, ctx)
  const k = prep2Check(row.sample, ctx)
  const rs = prep2Result(row.sample, ctx)
  return [
    `1:${fmt(plan.target)}`,
    `1:${fmt(plan.steps[0]?.ratio)}`,
    fmt(row.cartridge?.sensitivity) || '-',
    fmt(k.loqVial) || '-',
    fmtEu(rs.lt === true, rs.euPerVial) || '-',
    rs.verdict ? VERDICT_LABEL[rs.verdict] : '-',
  ]
}

function Outcome({ result }: { result: PrepRulesReapplyResult | undefined }) {
  if (!result)
    return <span className="text-muted-foreground">no reply for this row</span>
  return result.applied ? (
    <span className="text-emerald-700 dark:text-emerald-300">Re-applied</span>
  ) : (
    <span className="text-red-600 dark:text-red-400">
      Not re-applied: {result.reason}
    </span>
  )
}

interface Listed {
  candidate: PrepRulesReapplyCandidate
  /** The candidate's row on this page; absent only while the page catches
   *  up with the preview. */
  row: EndoRow | undefined
}

/**
 * Box 2's "Re-apply rules (n)" (spec 7, D3): exactly the rows the server's
 * preview lists (it is the authority, A.0 item 2), each with its old and new
 * figures and a checkbox. Only the ticked rows are sent; each one's outcome
 * shows on its row. The list is the one shown when it opened, so the
 * refresh after an apply never rewrites it under its results.
 */
export function ReapplyRules({
  worksheet,
  rows,
  ctx,
  cartridges,
  catalog,
  candidates,
  onReapply,
}: {
  worksheet: WorksheetListItem
  rows: EndoRow[]
  ctx: EndoCtx
  cartridges: EndoCartridgeOption[]
  catalog: ConsumableType[]
  candidates: PrepRulesReapplyCandidate[]
  onReapply: (itemIds: number[]) => Promise<PrepRulesReapplyResult[]>
}) {
  const [listed, setListed] = useState<Listed[] | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [results, setResults] = useState<Map<
    number,
    PrepRulesReapplyResult
  > | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function openList() {
    const next = candidates.map(candidate => ({
      candidate,
      row: rows.find(r => r.item.id === candidate.item_id),
    }))
    setListed(next)
    setPicked(
      new Set(
        next.filter(l => !hasReading(l.row)).map(l => l.candidate.item_id)
      )
    )
  }

  function close() {
    setListed(null)
    setResults(null)
    setError(null)
  }

  async function send() {
    if (!picked.size || sending) return
    setSending(true)
    setError(null)
    try {
      const res = await onReapply([...picked])
      setResults(new Map(res.map(r => [r.item_id, r])))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Re-apply failed')
    } finally {
      setSending(false)
    }
  }

  if (!candidates.length && listed === null) return null
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="mt-2"
        disabled={!candidates.length}
        onClick={openList}
      >
        Re-apply rules ({candidates.length})
      </Button>
      <Dialog
        open={listed !== null}
        onOpenChange={open => {
          if (!open && !sending) close()
        }}
      >
        {listed && (
          <DialogContent className="flex max-h-[88vh] w-[980px] max-w-[96vw] flex-col gap-3 sm:max-w-[96vw]">
            <DialogTitle className="text-sm font-semibold">
              Re-apply rules
            </DialogTitle>
            <DialogDescription className="text-xs">
              These rows are locked to a line that differs from the current
              rules. Re-applying moves a ticked row to the current line and
              keeps its current run in its history; typed values stay as they
              are. A reading was read at the old line, so it moves to the
              history and is cleared, and the sample is re-run: rows with a
              reading start unticked. Promoted rows and completed worksheets are
              never changed.
            </DialogDescription>
            <div className="min-h-0 overflow-auto">
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr>
                    <th className={TH} />
                    <th className={TH}>Sample ID</th>
                    <th className={TH}>Line, old to new</th>
                    {FIGURES.map(f => (
                      <th key={f} className={TH}>
                        {f}
                      </th>
                    ))}
                    {results && <th className={TH}>Result</th>}
                  </tr>
                </thead>
                <tbody>
                  {listed.map(({ candidate, row }) => {
                    const id = candidate.item_id
                    const identity = row?.sample.identity ?? ''
                    const before = figures(row, ctx)
                    const after = figures(
                      row &&
                        endoRowUnderRule(
                          row,
                          worksheet,
                          catalog,
                          candidate.new_rule
                        ),
                      ctx
                    )
                    // A read row shows what happens to its reading, never a
                    // verdict worked out again for it under the new line.
                    const moves = row !== undefined && hasReading(row)
                    const reading = row?.item.result_reading
                    return (
                      <tr key={id} data-item={id}>
                        <td className={HCELL}>
                          <Checkbox
                            aria-label={`Re-apply ${candidate.sample_id}`}
                            checked={picked.has(id)}
                            disabled={sending || results !== null}
                            onCheckedChange={on =>
                              setPicked(prev => {
                                const s = new Set(prev)
                                if (on === true) s.add(id)
                                else s.delete(id)
                                return s
                              })
                            }
                          />
                        </td>
                        <td className={`${HCELL} font-mono`}>
                          {candidate.sample_id}
                        </td>
                        <td className={HCELL}>
                          {lineLabel(candidate.old.rule, identity, cartridges)}
                          <span className="block text-teal-700 dark:text-teal-300">
                            to{' '}
                            {lineLabel(
                              candidate.new_rule,
                              identity,
                              cartridges
                            )}
                          </span>
                        </td>
                        {(moves ? before.slice(0, FROM_READING) : before).map(
                          (b, i) => (
                            <td
                              key={FIGURES[i]}
                              className={`${HCELL} whitespace-nowrap font-mono`}
                            >
                              {b === after[i] ? (
                                b
                              ) : (
                                <>
                                  {b}
                                  <span className="font-semibold text-teal-700 dark:text-teal-300">
                                    {` to ${after[i]}`}
                                  </span>
                                </>
                              )}
                            </td>
                          )
                        )}
                        {moves && (
                          <td
                            colSpan={FIGURES.length - FROM_READING}
                            className={`${HCELL} text-amber-700 dark:text-amber-300`}
                          >
                            Its reading{reading ? ` (${reading})` : ''} moves to
                            history; re-run the sample
                          </td>
                        )}
                        {results && (
                          <td className={HCELL}>
                            <Outcome result={results.get(id)} />
                          </td>
                        )}
                      </tr>
                    )
                  })}
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
                    disabled={!picked.size || sending}
                    onClick={() => void send()}
                  >
                    Re-apply {picked.size} {picked.size === 1 ? 'row' : 'rows'}
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
