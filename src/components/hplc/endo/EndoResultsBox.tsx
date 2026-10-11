import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { listServiceSpecs, type AnalysisServiceSpecRecord } from '@/lib/api'
import { fmt } from '@/lib/endo-prep'
import {
  BW_LIMIT_EU_PER_ML,
  LIMIT_EU_PER_VIAL,
  fmtConc,
  fmtEu,
  formOf,
  mk1Value,
  parseReading,
  prep2Check,
  prep2Result,
  type EndoCheck,
  type EndoCtx,
  type EndoResult,
  type EndoSample,
} from '@/lib/endo-prep-2ml'
import type { EndoRow } from '@/lib/endo-worksheet-2ml'
import { useAnalysisServices } from '@/services/analysis-services'
import { resolveServiceForAnalysis } from '@/components/senaite/AnalysisServiceLink'
import { ruleLabel } from '@/components/hplc/ServiceSpecsSection'
import {
  MONO,
  TD,
  TD_CALC,
  TH,
  TH_CALC,
  UNIT,
} from '@/components/hplc/EndoWorksheetTable'
import { EndoReadingInput } from './EndoReadingInput'
import { EndoBox, type EndoBoxProps } from './EndoBox'
import { WorkedTip } from './EndoWorkedTip'
import { useRowRefusals } from './use-row-refusals'

type Verdict = 'pass' | 'fail' | 'inconclusive' | 'invalid'

// Task 17's flyout reuses VERDICT_LABEL and VERDICT_TONE; an object export
// costs Fast Refresh on this file only.
// eslint-disable-next-line react-refresh/only-export-components
export const VERDICT_LABEL: Record<Verdict, string> = {
  pass: 'Pass',
  fail: 'Fail',
  inconclusive: 'Inconclusive',
  invalid: 'Invalid',
}

// Dennis's --ok, --crit, --warn, --crit.
// eslint-disable-next-line react-refresh/only-export-components
export const VERDICT_TONE: Record<Verdict, string> = {
  pass: 'text-emerald-600 dark:text-emerald-400',
  fail: 'text-red-600 dark:text-red-400',
  inconclusive: 'text-amber-600 dark:text-amber-400',
  invalid: 'text-red-600 dark:text-red-400',
}

/** "<2.5" for a derived value, nothing when there is none. */
const eu = (lt: boolean | null, v: number | null) => fmtEu(lt === true, v)

/** The peptide spec tier: the Peptide matrix row, else the All row. */
function peptideTier(
  specs: AnalysisServiceSpecRecord[] | undefined
): AnalysisServiceSpecRecord | null {
  const live = (specs ?? []).filter(s => s.active && s.peptide_id == null)
  return (
    live.find(s => s.matrix === 'Peptide') ??
    live.find(s => s.matrix == null) ??
    null
  )
}

/** Every computed cell's worked line, as Dennis's tip* helpers. */
function workedLines(s: EndoSample, k: EndoCheck, rs: EndoResult, bw: boolean) {
  const lam = fmt(k.lambda)
  const lt = rs.lt
  const rd = s.reader
  const why = (rd?.why ?? []).join('; ') || "failed the reader's checks"
  let verdict: string | null = null
  if (rs.verdict === 'invalid') {
    verdict = `Invalid test: ${why}. The reading proves nothing about the sample (USP <85>); rerun it, usually at a higher dilution`
  } else if (rs.verdict && bw) {
    verdict =
      rs.verdict === 'pass'
        ? `${eu(lt, rs.value)} EU/mL ≤ ${fmt(BW_LIMIT_EU_PER_ML)} EU/mL → Pass`
        : rs.verdict === 'fail'
          ? `${eu(lt, rs.value)} EU/mL > ${fmt(BW_LIMIT_EU_PER_ML)} EU/mL → Fail`
          : `A < reading whose floor is above ${fmt(BW_LIMIT_EU_PER_ML)} EU/mL proves nothing either way; a finer cartridge would`
  } else if (rs.verdict) {
    const v = `${eu(lt, rs.euPerVial)} EU/vial (${eu(lt, rs.euPerMg)} EU/mg)`
    verdict =
      rs.verdict === 'pass'
        ? `${v} ≤ ${LIMIT_EU_PER_VIAL} EU/vial limit → Pass`
        : rs.verdict === 'fail'
          ? `${v} > ${LIMIT_EU_PER_VIAL} EU/vial limit → Fail`
          : `${v}: a < result whose floor is above the ${LIMIT_EU_PER_VIAL} EU/vial limit proves nothing either way; a finer cartridge or more on the cartridge would`
  }
  return {
    cartridge:
      k.lambda === null
        ? null
        : `λ ${lam} EU/mL` +
          (k.valid === false
            ? `\nloaded ${fmtConc(k.loaded)} mg/mL is under the MVC ${fmtConc(k.mvc)}${k.needs !== null ? `; the ${fmt(k.needs)} cartridge holds it` : ''}`
            : '') +
          (k.failAt !== null ? `\na reading above ${fmt(k.failAt)} fails` : ''),
    loaded:
      k.loaded === null
        ? null
        : `${fmt(s.weightMg)} mg ÷ ${fmt(k.water)} mL ÷ ${fmt(k.dilution)} = ${fmtConc(k.loaded)} mg/mL on the MCS` +
          (k.mvc !== null
            ? `\nneeds ≥ ${fmtConc(k.mvc)} (the MVC for this vial)`
            : ''),
    mvd:
      k.mvd === null || !k.water
        ? null
        : `(${LIMIT_EU_PER_VIAL} EU/vial ÷ ${fmt(k.water)} mL = ${fmt(LIMIT_EU_PER_VIAL / k.water)} EU/mL) ÷ λ ${lam} EU/mL = ${fmt(k.mvd)}×\nyou use ${fmt(k.dilution)}×`,
    mvc:
      k.mvc === null || !s.weightMg
        ? null
        : `λ ${lam} EU/mL ÷ (${LIMIT_EU_PER_VIAL} EU/vial ÷ ${fmt(s.weightMg)} mg = ${fmt(LIMIT_EU_PER_VIAL / s.weightMg)} EU/mg) = ${fmtConc(k.mvc)} mg/mL` +
          (k.loaded !== null ? `\nloaded ${fmtConc(k.loaded)}` : ''),
    reader: !rd
      ? null
      : [
          rd.valid
            ? `Valid: spike recovery ${rd.rec_min ?? '-'}-${rd.rec_max ?? '-'} %, CV under ${rd.cv_limit ?? '-'} %`
            : `INVALID: ${why}`,
          `Spike recovery ${rd.recovery ?? '-'} % · sample CV ${rd.sample_cv ?? '-'} % · spike CV ${rd.spike_cv ?? '-'} %`,
          `Test ${rd.test_id} · ${rd.reader ?? '-'} (${rd.slot ?? '-'})`,
          `Cartridge lot ${rd.cartridge_lot ?? '-'}${rd.cartridge_expiry ? `, exp. ${rd.cartridge_expiry}` : ''} · ${rd.cartridge_range ?? '-'} EU/mL`,
          `${rd.operator ?? '-'} · ${rd.tested_at ?? '-'} · ${rd.temp_start ?? '-'}/${rd.temp_end ?? '-'} °C`,
          `From ${rd.file_name}`,
        ].join('\n'),
    euPerMg:
      bw || rs.euPerMg === null
        ? null
        : `${eu(lt, rs.euPerVial)} EU/vial ÷ ${fmt(s.weightMg)} mg = ${eu(lt, rs.euPerMg)} EU/mg`,
    lod:
      k.lod === null
        ? null
        : `LOD: ${fmt(k.lod)} EU/mL, the lowest value the ${lam} cartridge reads; the dilution does not change it`,
    loq: bw
      ? k.loqMl === null
        ? null
        : `LOQ: ${fmt(k.lod)} EU/mL × ${fmt(k.dilution)} = ${fmt(k.loqMl)} EU per mL of the bac water, the lowest this prep can report`
      : k.loqVial === null
        ? null
        : `LOQ: ${fmt(k.lod)} EU/mL × 1:${fmt(k.dilution)} × ${fmt(k.water)} mL = ${fmt(k.loqVial)} EU per vial, the lowest this prep can report`,
    euPerVial:
      bw || rs.euPerVial === null
        ? null
        : `${eu(lt, rs.value)} EU/mL on the MCS × 1:${fmt(k.dilution)} = ${eu(lt, rs.euPerMlVial)} EU/mL of the vial solution × ${fmt(k.water)} mL = ${eu(lt, rs.euPerVial)} EU`,
    limit: bw
      ? `${fmt(BW_LIMIT_EU_PER_ML)} EU per mL of the bac water (the USP limit for water for injection); above it the verdict is Fail\nThe worksheet's working limit, not yet the COA spec`
      : `${LIMIT_EU_PER_VIAL} EU per vial, flat: the whole vial as one dose\nThe worksheet's working limit, not yet the COA spec`,
    verdict,
    mk1Empty:
      rs.verdict === 'invalid'
        ? `Invalid test (${why}): nothing goes to Accu-Mk1 until it is rerun`
        : bw
          ? 'Bac water: its reading goes into Accu-Mk1 as EU/mL once it is typed'
          : formOf(s) === 'liquid' && k.water === null
            ? "Type the customer's reconstitution water first; EU/vial needs it"
            : 'Peptides go into Accu-Mk1 as EU/vial once a reading is typed',
  }
}

async function copyValue(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    toast.success(`Copied ${value}`)
  } catch {
    toast.error('Could not copy; select the number and press Ctrl+C')
  }
}

function Calc({
  tip,
  className,
  children,
}: {
  tip: string | null
  className?: string
  children: ReactNode
}) {
  return (
    <td className={`${TD_CALC} ${className ?? ''}`}>
      <WorkedTip tip={tip}>{children}</WorkedTip>
    </td>
  )
}

function CellUnit({ children }: { children: ReactNode }) {
  return (
    <span className="ml-0.5 font-sans text-[10px] font-normal text-muted-foreground">
      {children}
    </span>
  )
}

function ResultRow({
  row,
  ctx,
  isCompleted,
  refusal,
  onReading,
}: {
  row: EndoRow
  ctx: EndoCtx
  isCompleted: boolean
  /** Why the row's last save was refused, until its next save. */
  refusal: string | undefined
  onReading: (reading: string | null) => void
}) {
  const s = row.sample
  const k = prep2Check(s, ctx)
  const rs = prep2Result(s, ctx)
  const mk = mk1Value(s, ctx)
  const bw = formOf(s) === 'bac'
  const rd = s.reader
  const tips = workedLines(s, k, rs, bw)
  const verdict = rs.verdict
  // A reading typed over an imported one keeps the reader's record; say so
  // when the two disagree (the record's validity still governs the verdict).
  const typed = parseReading(s.reading)
  const exported = rd ? parseReading(rd.result) : null
  // The larger CV the record carries; none is "-", never a CV of 0.
  const cvs = [rd?.sample_cv, rd?.spike_cv].filter(
    (v): v is number => v != null
  )
  const readerDiffers =
    rd !== null &&
    typed !== null &&
    (exported === null ||
      exported.lt !== typed.lt ||
      exported.value !== typed.value)
  return (
    <tr className="group/item hover:bg-teal-500/[0.04] dark:hover:bg-teal-400/[0.06]">
      <td
        className={`${TD} pl-3 pr-1.5 text-right font-mono text-[11px] text-muted-foreground`}
      >
        {row.n}
      </td>
      <td
        className={`${TD} ${s.sampleId ? MONO : 'text-xs italic text-muted-foreground'}`}
      >
        {s.sampleId || 'no ID yet'}
      </td>
      <td className={`${TD} ${MONO} text-right text-foreground/80`}>
        {bw ? '' : fmt(s.weightMg)}
      </td>
      <td className={`${TD_CALC} !text-left`}>
        {k.lambda === null ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <WorkedTip tip={tips.cartridge}>
            {fmt(k.lambda)}
            {k.valid === false && (
              <span
                className={`block whitespace-normal font-sans text-[11px] font-semibold leading-tight ${k.needs !== null ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}
              >
                {k.needs !== null
                  ? `needs the ${fmt(k.needs)}`
                  : 'no cartridge holds this'}
              </span>
            )}
          </WorkedTip>
        )}
      </td>
      <Calc tip={tips.loaded}>{fmtConc(k.loaded)}</Calc>
      <Calc tip={tips.mvd}>{k.mvd === null ? '' : `${fmt(k.mvd)}×`}</Calc>
      <Calc tip={tips.mvc}>{fmtConc(k.mvc)}</Calc>
      <td className={`${TD} w-[92px] px-1 text-right`}>
        <EndoReadingInput
          value={s.reading}
          placeholder={`<${fmt(k.floorShown ?? 0.05)}`}
          disabled={isCompleted}
          label={`Reading for ${row.item.sample_id}`}
          onCommit={onReading}
        />
        {rs.floorMismatch && (
          <div className="mt-[3px] max-w-[11em] text-[11px] leading-tight text-amber-600 dark:text-amber-400">
            not this cartridge&apos;s floor (expected &lt;
            {fmt(rs.expectedFloor)})
          </div>
        )}
        {readerDiffers && rd && (
          <div className="mt-[3px] max-w-[11em] text-[11px] leading-tight text-amber-600 dark:text-amber-400">
            the reader exported {rd.result}
          </div>
        )}
        {refusal && (
          <div
            role="alert"
            className="mt-[3px] max-w-[11em] whitespace-normal break-words text-left text-[11px] font-semibold leading-snug text-red-600 dark:text-red-400"
          >
            Not saved: {refusal}
          </div>
        )}
      </td>
      <Calc
        tip={tips.reader}
        className={
          rd && !rd.valid
            ? 'font-semibold !text-red-600 dark:!text-red-400'
            : ''
        }
      >
        {rd
          ? `${rd.recovery == null ? '-' : `${rd.recovery} %`} · ${cvs.length ? fmt(Math.max(...cvs)) : '-'}`
          : ''}
      </Calc>
      <Calc tip={tips.euPerMg}>{bw ? '' : eu(rs.lt, rs.euPerMg)}</Calc>
      <Calc tip={tips.lod}>{fmt(k.lod)}</Calc>
      <Calc tip={tips.loq}>
        {bw ? (
          k.loqMl === null ? (
            ''
          ) : (
            <>
              {fmt(k.loqMl)}
              <CellUnit>/mL</CellUnit>
            </>
          )
        ) : (
          fmt(k.loqVial)
        )}
      </Calc>
      <Calc tip={tips.euPerVial}>{bw ? '' : eu(rs.lt, rs.euPerVial)}</Calc>
      <Calc tip={tips.limit}>
        {bw ? (
          <>
            {fmt(BW_LIMIT_EU_PER_ML)}
            <CellUnit>/mL</CellUnit>
          </>
        ) : (
          fmt(rs.limitPerVial ?? LIMIT_EU_PER_VIAL)
        )}
      </Calc>
      <td
        className={`${TD} whitespace-nowrap font-semibold ${verdict ? VERDICT_TONE[verdict] : ''}`}
      >
        {verdict && (
          <WorkedTip tip={tips.verdict}>{VERDICT_LABEL[verdict]}</WorkedTip>
        )}
      </td>
      {/* Dennis's td.mk1: --mk1-soft #dfe9ff (dark #22304f) fill and a 3px
          --mk1-edge #3b6fd6 (dark #8fb0ff) left edge, on the theme palette. */}
      {mk ? (
        <td
          className={`${TD} whitespace-nowrap border-l-[3px] border-l-blue-600 bg-blue-500/10 font-mono font-semibold dark:border-l-blue-300 dark:bg-blue-400/15`}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`Copy ${mk.value} for Accu-Mk1`}
                className="cursor-copy focus-visible:outline-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-300"
                onClick={() => void copyValue(mk.value)}
              >
                {mk.value}
                <CellUnit>{mk.unit}</CellUnit>
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm p-0">
              <div className="p-3 font-mono text-xs">
                Into Accu-Mk1: {mk.value} {mk.unit}
                {bw
                  ? ', bac water reports the reading itself'
                  : ', peptides report EU per vial'}
                . Click to copy the number.
              </div>
            </TooltipContent>
          </Tooltip>
        </td>
      ) : (
        <td
          className={`${TD} border-l-[3px] border-l-blue-600/35 dark:border-l-blue-300/35`}
        >
          <WorkedTip tip={tips.mk1Empty} className="block min-h-5">
            {null}
          </WorkedTip>
        </td>
      )}
    </tr>
  )
}

/**
 * Box 3, Results (2 mL worksheets only; stock worksheets have no Results
 * box), as Dennis's 2 mL Results section: the reading typed as the MCS shows
 * it, the reader's checks, and from them LOD, LOQ, EU/mg, EU per vial, the
 * verdict against the worksheet's working limits, and the value to enter in
 * Accu-Mk1 (blue, click to copy). Rows in bench order, numbered as Box 1.
 * Every computed cell shows its worked line on hover. A save refused (by the
 * server, or here when no cartridge resolves) shows its reason on the row
 * until that row's next save.
 */
export function EndoResultsBox({
  rows,
  ctx,
  isCompleted,
  onUpdateItem,
}: EndoBoxProps) {
  const services = useAnalysisServices().data
  const endoAnalysis = rows
    .flatMap(r => r.item.analyses ?? [])
    .find(a => /ENDO/i.test(a.keyword ?? ''))
  const service = endoAnalysis
    ? resolveServiceForAnalysis(
        {
          analysis_service_id: endoAnalysis.analysis_service_id ?? null,
          keyword: endoAnalysis.keyword ?? null,
        },
        services
      )
    : null
  const { data: specs } = useQuery({
    queryKey: ['analysis-services', service?.id, 'specs'],
    queryFn: () => listServiceSpecs(service?.id ?? 0),
    enabled: service != null,
    staleTime: 60_000,
  })
  const { refused, send, refuse } = useRowRefusals(onUpdateItem)

  if (!rows.length) return null
  const tier = peptideTier(specs)
  // Unit and limit come from the service's spec rows, never hardcoded: the
  // 09-01 snapshot (<= 5 EU/mL) is unverified against prod.
  const note = tier
    ? `Accu-Mk1 values are per vial; Mk1's endotoxin test reports ${tier.unit ?? 'its own unit'} against ${ruleLabel(tier)} until the spec switch.`
    : specs
      ? 'Accu-Mk1 values are per vial; the endotoxin test has no peptide spec set yet, so check its unit in Accu-Mk1 before entering a value.'
      : 'Accu-Mk1 values are per vial.'
  const p = ctx.params

  // The reading goes with the row's resolved cartridge when the item has
  // none of its own (spec 9); with no cartridge at all the server would
  // refuse it, so it is refused here instead.
  function saveReading(row: EndoRow, reading: string | null) {
    const { item } = row
    if (reading === null || item.cartridge_type_id != null) {
      send(item.id, { result_reading: reading })
      return
    }
    if (!row.cartridge) {
      refuse(
        item.id,
        "set the run cartridge (or this row's) before saving a reading"
      )
      return
    }
    send(item.id, {
      result_reading: reading,
      cartridge_type_id: row.cartridge.id,
    })
  }

  return (
    <EndoBox
      n={3}
      title="Results: EU per vial"
      sub={
        <>
          <span className="block font-medium text-foreground/80">{note}</span>
          Type the reading as the instrument shows it with the MCS factor at 1,
          with its &lt; if it has one: EU/mL of the step 3 tube. The sheet
          multiplies by the row&apos;s total (× {fmt(p.stdTotalDilution)}) for
          EU/mL of the vial solution and by the volume (× {fmt(p.reconWaterMl)}{' '}
          mL) for EU/vial; Pass is ≤ {LIMIT_EU_PER_VIAL} EU/vial. Bac water is
          typed as shown with its 20× applied, EU/mL of the bac water, and
          passes at ≤ {fmt(BW_LIMIT_EU_PER_ML)} EU/mL. These working limits are
          not yet the COA spec. The blue Accu-Mk1 column is the value to enter
          there: EU/vial for peptides, EU/mL for bac water; click it to copy.
          This section is not printed.
        </>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] border-collapse">
          <thead>
            <tr>
              <th className={`${TH} w-[34px]`} />
              <th className={TH}>Sample ID</th>
              <th className={`${TH} !text-right`}>
                Declared wt<span className={UNIT}>mg</span>
              </th>
              <th className={`${TH} ${TH_CALC} !text-left`}>
                Cartridge<span className={UNIT}>λ EU/mL</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                Loaded<span className={UNIT}>mg/mL on the MCS</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                MVD<span className={UNIT}>×</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                MVC<span className={UNIT}>mg/mL</span>
              </th>
              <th className={`${TH} !text-right`}>
                Reading<span className={UNIT}>EU/mL on the MCS, factor 1</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                Reader<span className={UNIT}>spike rec. · CV</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>EU/mg</th>
              <th className={`${TH} ${TH_CALC}`}>
                LOD<span className={UNIT}>EU/mL, cartridge</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                LOQ<span className={UNIT}>EU/vial</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                EU/vial<span className={UNIT}>EU</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                Limit<span className={UNIT}>EU/vial</span>
              </th>
              <th className={TH}>Verdict</th>
              <th className={TH}>
                Accu-Mk1
                <span className="ml-1 rounded-full border border-blue-600 bg-blue-500/10 px-1.5 text-[10.5px] font-bold normal-case tracking-normal text-foreground dark:border-blue-300 dark:bg-blue-400/15">
                  → Mk1
                </span>
                <span className={UNIT}>EU/vial · bac water EU/mL</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <ResultRow
                key={row.item.id}
                row={row}
                ctx={ctx}
                isCompleted={isCompleted}
                refusal={refused[row.item.id]}
                onReading={reading => saveReading(row, reading)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </EndoBox>
  )
}

export default EndoResultsBox
