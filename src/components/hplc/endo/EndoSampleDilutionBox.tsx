import { useRef, useState, type ReactNode } from 'react'
import type { WorksheetItemPatch } from '@/lib/api'
import { fmt, fmtUl } from '@/lib/endo-prep'
import {
  BW_LIMIT_EU_PER_ML,
  TUBE_UL,
  dilutionPlan,
  fmtConc,
  formOf,
  orderByTotal,
  prep2Check,
  type EndoCheck,
  type EndoSample,
  type EndoStepPlan,
} from '@/lib/endo-prep-2ml'
import {
  BW_LAL_UL,
  BW_SAMPLE_UL,
  standardSteps,
  totalGroupKey,
  type EndoRow,
} from '@/lib/endo-worksheet-2ml'
import { PrepField } from '@/components/hplc/EndoPrepLine'
import { MONO, TH, TH_CALC, UNIT } from '@/components/hplc/EndoWorksheetTable'
import { EndoBox, type EndoBoxProps } from './EndoBox'
import { WorkedTip } from './EndoWorkedTip'

// Dennis's .dilution-table cells: top-aligned, 7px top and bottom.
const CELL = 'border-b border-border/60 px-2 py-[7px] align-top text-[13px]'
// The first row of the next total (his tr.newtotal: 2px, ink at 28%).
const GROUP_RULE = 'border-t-2 border-t-foreground/30'

// Dennis's step colours (--s1 #2F6DB5 Tris, --s2 #2D7D4F LAL water, --s3
// #A2620F BG600; dark #7FB2EE, #7CCB9A, #E5B163) on the theme palette.
const STEPS = [
  {
    name: 'Tris',
    short: 'Tris',
    ratioCap: 'ratio',
    th: '!text-blue-700 dark:!text-blue-300',
    text: 'text-blue-700 dark:text-blue-300',
    cell: 'bg-blue-500/[0.07] dark:bg-blue-400/[0.09]',
  },
  {
    name: 'LAL water',
    short: 'water',
    ratioCap: 'ratio · from total',
    th: '!text-green-700 dark:!text-green-300',
    text: 'text-green-700 dark:text-green-300',
    cell: 'bg-green-500/[0.07] dark:bg-green-400/[0.08]',
  },
  {
    name: 'BG600',
    short: 'BG600',
    ratioCap: 'ratio · fixed',
    th: '!text-amber-700 dark:!text-amber-300',
    text: 'text-amber-700 dark:text-amber-300',
    cell: 'bg-amber-500/[0.08] dark:bg-amber-400/[0.09]',
  },
] as const
// The vial solution, the source of step 1 (his --sv #7A4FB5, dark #B99BEB).
const VIAL_TONE = 'text-violet-600 dark:text-violet-300'

type PrepSteps = WorksheetItemPatch['prep_steps']

/**
 * The row's prep_steps after one cell is typed. On the wire each step is
 * [sample_ul, ratio] (step 1) or [sample_ul] (steps 2 and 3); null is the
 * standard. The server wants a sample volume in every entry, so a ratio
 * typed alone carries the step's current sample volume with it. An entry
 * back at the standard becomes null; all three standard sends null.
 */
function nextPrepSteps(
  current: PrepSteps,
  i: number,
  field: 'sample' | 'ratio',
  v: number | null,
  plan: EndoStepPlan[],
  std: EndoStepPlan[]
): PrepSteps {
  const p = plan[i]
  const d = std[i]
  if (!p || !d) return current ?? null
  const next = [0, 1, 2].map(j => current?.[j] ?? null)
  const dSample = d.sampleUl ?? 0
  const dRatio = d.ratio ?? 1
  const sample = field === 'sample' ? (v ?? dSample) : (p.sampleUl ?? dSample)
  const ratio = field === 'ratio' ? (v ?? dRatio) : (p.ratio ?? dRatio)
  const standard = sample === dSample && (i !== 0 || ratio === dRatio)
  next[i] = standard ? null : i === 0 ? [sample, ratio] : [sample]
  return next.every(e => e === null) ? null : next
}

function loadedTip(s: EndoSample, k: EndoCheck): string | null {
  if (k.loaded === null) return null
  return (
    `${fmt(s.weightMg)} mg ÷ ${fmt(k.water)} mL ÷ ${fmt(k.dilution)} = ${fmtConc(k.loaded)} mg/mL on the MCS` +
    (k.mvc !== null
      ? `\nneeds ≥ ${fmtConc(k.mvc)} (the MVC for this vial)`
      : '')
  )
}

/** A caption over each value, so it is plain which number is which. */
function Slot({
  cap,
  tone,
  end,
  children,
}: {
  cap: string
  tone?: string
  end?: boolean
  children: ReactNode
}) {
  return (
    <span
      className={`inline-flex flex-col gap-0.5 ${end ? 'items-end' : 'items-start'}`}
    >
      <span
        className={`whitespace-nowrap font-sans text-[10px] leading-[1.1] tracking-[0.02em] ${tone ? `font-semibold ${tone}` : 'text-muted-foreground'}`}
      >
        {cap}
      </span>
      <span className="inline-flex min-h-[26px] items-center">{children}</span>
    </span>
  )
}

function StepCell({
  st,
  d,
  si,
  cell,
  isCompleted,
  onCommit,
}: {
  st: EndoStepPlan
  d: EndoStepPlan
  si: number
  cell: string
  isCompleted: boolean
  onCommit: (field: 'sample' | 'ratio', v: number | null) => void
}) {
  const tone = STEPS[si] ?? STEPS[0]
  const prev = STEPS[si - 1]
  const sampleOwn = st.sampleUl !== d.sampleUl
  const ratioOwn = si === 0 && st.ratio !== d.ratio
  const made = st.diluentUl !== null && st.totalUl !== null
  const from = si ? `step ${si}` : 'the vial solution'
  const fac = !made
    ? st.sampleUl
      ? 'ratio must be at least 1:1'
      : 'no sample volume'
    : st.fits
      ? `1:${fmt(st.running)} dilution`
      : `over the ${fmt(TUBE_UL / 1000)} mL tube: ${fmtUl(st.totalUl)} µL, take less sample`
  const tip = [
    `Step ${si + 1}: ${fmtUl(st.sampleUl)} µL of ${from} + ${made ? fmtUl(st.diluentUl) : '?'} µL ${st.diluent} = ${made ? fmtUl(st.totalUl) : '?'} µL`,
    made ? `1:${fmt(st.ratio)}, 1:${fmt(st.running)} so far` : null,
    st.own
      ? `Set by hand; the standard is ${si === 0 ? `1:${fmt(d.ratio)}, ` : ''}${fmtUl(d.sampleUl)} µL`
      : null,
    st.fits ? null : `Does not fit a ${fmt(TUBE_UL / 1000)} mL tube`,
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <td className={`${cell} border-l pl-2.5 pr-2 ${tone.cell}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-2.5 gap-y-1">
        <Slot cap={tone.ratioCap}>
          <span className="inline-flex items-center gap-px font-mono text-foreground/80">
            1:
            {si === 0 ? (
              <span className="block w-[3.2em]">
                <PrepField
                  bare
                  label="Step 1 ratio"
                  unit="1 in N"
                  value={ratioOwn ? st.ratio : null}
                  overridden={ratioOwn}
                  computed={d.ratio}
                  disabled={isCompleted}
                  onCommit={v => onCommit('ratio', v)}
                />
              </span>
            ) : st.ratio === null || st.ratio < 1 ? (
              '?'
            ) : (
              fmt(st.ratio)
            )}
          </span>
        </Slot>
        <span className="ml-auto inline-flex items-start gap-3.5">
          <Slot
            cap={si ? `from step ${si}` : 'sample'}
            tone={prev ? prev.text : VIAL_TONE}
          >
            <span className="block w-[3.6em]">
              <PrepField
                bare
                label={`Step ${si + 1} sample`}
                unit="µL"
                value={sampleOwn ? st.sampleUl : null}
                overridden={sampleOwn}
                computed={d.sampleUl}
                disabled={isCompleted}
                onCommit={v => onCommit('sample', v)}
              />
            </span>
          </Slot>
          <Slot cap={`${tone.short} to add`} tone={tone.text} end>
            <WorkedTip
              tip={tip}
              className={`whitespace-nowrap font-mono font-semibold ${made && st.fits ? tone.text : 'text-red-600 dark:text-red-400'}`}
            >
              {made ? `+ ${fmtUl(st.diluentUl)}` : '?'}
            </WorkedTip>
          </Slot>
        </span>
      </div>
      <div
        className={`mt-[3px] whitespace-normal font-mono text-[11px] ${!st.fits ? 'font-semibold text-red-600 dark:text-red-400' : st.own ? 'text-teal-700 dark:text-teal-300' : 'text-muted-foreground'}`}
      >
        {fac}
      </div>
    </td>
  )
}

/**
 * Box 2, Sample dilution (2 mL worksheets; the page mounts it only then), as
 * Dennis's section of the same name: the total wanted, then the three bench
 * steps from the vial to the cartridge (Tris at a chosen ratio, LAL water
 * derived to land on the total, BG600 fixed at 1:2), each with what is
 * taken, what is added, the running dilution and a warning when the 1.5 mL
 * tube overflows; then what lands on the MCS. Grouped by total (1:250s
 * first) with a rule where the total changes; the row number is Box 1's.
 * Everything derived comes from src/lib/endo-prep-2ml.ts, the same code the
 * 2 mL bench sheet uses. A save the server refuses (a total under twice the
 * step 1 ratio, say) shows its reason on the row until that row's next save.
 */
export function EndoSampleDilutionBox({
  rows,
  ctx,
  isCompleted,
  onUpdateItem,
}: EndoBoxProps) {
  // The server's refusal per item id, from onUpdateItem's resolved message.
  const [refused, setRefused] = useState<Record<number, string>>({})
  // Each row's latest save: only its outcome may set the row's refusal, so
  // an earlier refusal landing after a later save is dropped.
  const latestSend = useRef<Record<number, number>>({})
  if (!rows.length) return null
  const std = standardSteps(ctx)
  const ordered = orderByTotal(rows, r => r.sample, ctx)
  const keys = ordered.map(r => totalGroupKey(r.sample, ctx))
  const stdTotal = ctx.params.stdTotalDilution

  function send(row: EndoRow, data: WorksheetItemPatch) {
    const id = row.item.id
    const seq = (latestSend.current[id] ?? 0) + 1
    latestSend.current[id] = seq
    setRefused(({ [id]: _cleared, ...rest }) => rest)
    void Promise.resolve(onUpdateItem(id, data)).then(msg => {
      if (msg && latestSend.current[id] === seq)
        setRefused(r => ({ ...r, [id]: msg }))
    })
  }

  function commitStep(
    row: EndoRow,
    i: number,
    field: 'sample' | 'ratio',
    v: number | null
  ) {
    const current = row.item.prep_steps ?? null
    const next = nextPrepSteps(
      current,
      i,
      field,
      v,
      dilutionPlan(row.sample, ctx).steps,
      std
    )
    if (JSON.stringify(next) === JSON.stringify(current)) return
    send(row, { prep_steps: next })
  }

  function commitTotal(row: EndoRow, v: number | null) {
    const next = v === stdTotal ? null : v
    if (next === (row.item.prep_total_dilution ?? null)) return
    send(row, { prep_total_dilution: next })
  }

  return (
    <EndoBox
      n={2}
      title="Sample dilution: from the vial to the cartridge"
      sub={
        <>
          Type the total you want (1:{fmt(stdTotal)} standard). Step 1 is Tris
          at the ratio you choose, step 3 is always 1:2 in BG600, and the sheet
          works out step 2 in LAL water to land on your total. Type the µL you
          take at each step; the amount to add is worked out. Every step is made
          in a {fmt(TUBE_UL / 1000)} mL tube. The MCS factor stays at 1.
        </>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] table-fixed border-collapse">
          <colgroup>
            <col className="w-[36px]" />
            <col className="w-[96px]" />
            <col className="w-[112px]" />
            <col />
            <col />
            <col />
            <col className="w-[124px]" />
          </colgroup>
          <thead>
            <tr>
              <th className={TH} />
              <th className={TH}>Sample ID</th>
              <th className={TH}>
                Total<span className={UNIT}>1 : N into the cartridge</span>
              </th>
              {std.map((st, si) => {
                const tone = STEPS[si] ?? STEPS[0]
                return (
                  <th
                    key={si}
                    className={`${TH} !text-center shadow-[inset_0_3px_0_currentColor] ${tone.th}`}
                  >
                    Step {si + 1} · {tone.name}
                    <span className={`${UNIT} !whitespace-normal`}>
                      {st.diluent} · volumes in µL
                    </span>
                  </th>
                )
              })}
              <th className={`${TH} ${TH_CALC} border-l pl-3 pr-[22px]`}>
                Loaded
                <span className={`${UNIT} !whitespace-normal`}>
                  mg/mL on the MCS
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((row, i) => {
              const s = row.sample
              const newGroup = i > 0 && keys[i] !== keys[i - 1]
              const cell = newGroup ? `${CELL} ${GROUP_RULE}` : CELL
              const plan = dilutionPlan(s, ctx)
              const lead = (
                <>
                  <td
                    className={`${cell} px-1 text-center font-mono text-[11px] text-muted-foreground`}
                  >
                    <WorkedTip
                      tip={`Row ${row.n} on the Prep table; this section is grouped by total`}
                    >
                      {row.n}
                    </WorkedTip>
                  </td>
                  <td
                    className={`${cell} pl-2 ${s.sampleId ? MONO : 'text-xs italic text-muted-foreground'}`}
                  >
                    {s.sampleId || 'no ID yet'}
                  </td>
                </>
              )

              if (formOf(s) === 'bac') {
                // Bac water is already a liquid: one straight 20x (the plan's
                // total), laid out like a step cell across the three steps.
                return (
                  <tr
                    key={row.item.id}
                    data-group-start={newGroup || undefined}
                  >
                    {lead}
                    <td
                      className={`${cell} pl-2.5 font-mono text-foreground/80`}
                    >
                      1:{fmt(plan.total)}
                    </td>
                    <td colSpan={3} className={`${cell} border-l pl-2.5 pr-2`}>
                      <div className="flex flex-wrap items-start justify-between gap-x-2.5 gap-y-1">
                        <span className="text-xs font-semibold text-foreground/80">
                          Bacteriostatic water · one step
                        </span>
                        <span className="ml-auto inline-flex items-start gap-3.5">
                          <Slot cap="sample">
                            <span className="font-mono text-foreground/80">
                              {fmtUl(BW_SAMPLE_UL)}
                            </span>
                          </Slot>
                          <Slot cap="LAL water to add" end>
                            <span className="whitespace-nowrap font-mono font-semibold">
                              + {fmtUl(BW_LAL_UL)}
                            </span>
                          </Slot>
                        </span>
                      </div>
                      <div className="mt-[3px] font-mono text-[11px] text-muted-foreground">
                        1:{fmt(plan.total)} dilution · one tube · limit{' '}
                        {fmt(BW_LIMIT_EU_PER_ML)} EU/mL
                      </div>
                    </td>
                    <td className={`${cell} border-l pl-3 pr-[22px]`} />
                  </tr>
                )
              }

              const k = prep2Check(s, ctx)
              const ownTotal = plan.target !== stdTotal
              const refusal = refused[row.item.id]
              const totalTip =
                plan.total === null
                  ? 'This total cannot be made with the steps as typed'
                  : `${plan.steps.map(st => `1:${fmt(st.ratio)}`).join(' × ')} = 1:${fmt(plan.total)}` +
                    `\nMCS factor 1: type the reading as it prints and the sheet multiplies by ${fmt(plan.target)}` +
                    (ownTotal
                      ? `\nThe standard is 1:${fmt(stdTotal)}; clear the cell to use it`
                      : '')
              return (
                <tr key={row.item.id} data-group-start={newGroup || undefined}>
                  {lead}
                  <td
                    className={`${cell} pl-2.5 ${plan.total === null ? 'text-red-600 dark:text-red-400' : ''}`}
                  >
                    <WorkedTip
                      tip={totalTip}
                      className="flex items-center gap-0.5 font-mono text-foreground/80"
                    >
                      1:
                      <span className="block w-[4.4em]">
                        <PrepField
                          bare
                          label="Total dilution"
                          unit="1 in N"
                          value={row.item.prep_total_dilution ?? null}
                          overridden={row.item.prep_total_dilution != null}
                          computed={stdTotal}
                          disabled={isCompleted}
                          onCommit={v => commitTotal(row, v)}
                        />
                      </span>
                    </WorkedTip>
                    {plan.total === null && (
                      <div className="mt-[3px] text-[11px] font-semibold">
                        cannot be made as typed
                      </div>
                    )}
                    {refusal && (
                      <div
                        role="alert"
                        className="mt-[3px] whitespace-normal break-words text-[11px] font-semibold leading-snug text-red-600 dark:text-red-400"
                      >
                        Not saved: {refusal}
                      </div>
                    )}
                  </td>
                  {plan.steps.map((st, si) => (
                    <StepCell
                      key={si}
                      st={st}
                      d={std[si] ?? st}
                      si={si}
                      cell={cell}
                      isCompleted={isCompleted}
                      onCommit={(field, v) => commitStep(row, si, field, v)}
                    />
                  ))}
                  <td
                    className={`${cell} border-l bg-teal-500/[0.06] pl-3 pr-[22px] text-right ${MONO} text-foreground/80`}
                  >
                    <WorkedTip tip={loadedTip(s, k)}>
                      {fmtConc(k.loaded)}
                    </WorkedTip>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </EndoBox>
  )
}

export default EndoSampleDilutionBox
