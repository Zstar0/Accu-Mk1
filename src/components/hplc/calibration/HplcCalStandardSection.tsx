import type { ReactNode } from 'react'
import type { Instrument, PeptideRecord } from '@/lib/api'
import {
  COUNTERIONS,
  MS_IONS,
  type CalInputs,
  type CalNetInputs,
  type CalWorked,
} from '@/lib/hplc-calibration'
import { fmtDp } from '@/components/hplc/prep/HplcSheetCells'
import { CalNumberBox, CalSelect, CalTextBox } from './CalCells'
import { HelpLabel } from './CalTip'
import {
  MS_ION_LABELS,
  NET_FIELDS,
  STEP1_FIELDS,
  type CalField,
  type NetKey,
  type Step1Key,
} from './cal-sheet-columns'

/** Where a box writes: a sheet field, the net block, the stock, a level. */
export type CalPart = 'sheet' | 'net' | 'stock' | 'level'
export type CalCommit = (
  part: CalPart,
  index: number,
  field: string,
  value: number | string | boolean | null
) => void

const FILED_HELP =
  'This curve is filed, so its compound and instrument stay as filed. To run the same vials on another instrument, use Duplicate for another injection.'

const helpOf = (f: CalField) => (f.title ? [f.title] : [])

export function Step({
  no,
  title,
  sub,
  children,
  extra,
}: {
  no?: string
  title: string
  sub?: string
  children: ReactNode
  extra?: ReactNode
}) {
  const id = title.replace(/\W+/g, '-').toLowerCase()
  return (
    <section
      aria-labelledby={id}
      className="rounded-lg border bg-card p-4 shadow-sm"
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={id} className="text-[15px] font-semibold">
          {no && (
            <span className="mr-2 text-teal-700 dark:text-teal-400">{no}</span>
          )}
          {title}
        </h3>
        {extra}
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </div>
      {children}
    </section>
  )
}

function Cell({ field, children }: { field: CalField; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">
        <HelpLabel label={field.label} lines={helpOf(field)} />
      </span>
      <div>{children}</div>
    </div>
  )
}

/** The net summary line, as cal.js renderNet (226) builds it, with the
 *  calc.js netPeptide (2759 to 2789) notes worked from the twin's figures. */
// eslint-disable-next-line react-refresh/only-export-components
export function netSummary(
  worked: CalWorked,
  net: CalNetInputs | null | undefined
) {
  const n = worked.net
  const f = (v: number | null, dp: number) => fmtDp(v, dp)
  const parts: string[] = []
  const free = n.free_mw
  const stated = n.stated_fw
  if (n.assumed_fw)
    parts.push(
      `Free-peptide MW not entered: the stated FW ${f(stated, 2)} is taken as the free peptide (sum the formula to confirm it).`
    )
  else if (n.fw_basis === 'free')
    parts.push(
      `Stated FW ${f(stated, 2)} matches the free peptide (${f(free, 2)}): the counterion sits outside it, so the correction applies.`
    )
  else if (
    n.fw_basis === 'salt' &&
    free !== null &&
    stated !== null &&
    n.counterion_mw
  ) {
    const kr = Math.round((stated - free) / n.counterion_mw)
    parts.push(
      `Stated FW ${f(stated, 2)} = free peptide + ${kr} × ${n.counterion} (${f(free + kr * n.counterion_mw, 2)}): the FW is the salt, so the fraction is free MW ÷ stated FW and nothing further is applied.`
    )
  } else if (n.fw_basis === 'mismatch')
    parts.push(
      n.counterion && n.counterion_mw
        ? `Stated FW ${f(stated, 2)} is neither the free peptide (${f(free, 2)}) nor the free peptide plus whole ${n.counterion} equivalents: check the CoA.`
        : `Stated FW ${f(stated, 2)} differs from the free peptide (${f(free, 2)}) and no counterion is chosen: if the FW includes one, choose it.`
    )
  if (n.ms_m !== null && free !== null) {
    const d = n.ms_m - free
    const ok = Math.abs(d) <= Math.max(1.5, free * 0.001)
    const ion = MS_ION_LABELS[net?.ms_ion ?? ''] ?? net?.ms_ion ?? ''
    const mz = typeof net?.ms_mz === 'number' ? net.ms_mz : null
    parts.push(
      ok
        ? `Mass spec ${ion} ${f(mz, 1)} → ${f(n.ms_m, 1)}, within ${f(Math.abs(d), 1)} Da of the free peptide: MS sees the peptide with the counterion gone, which confirms the free-peptide MW.`
        : `Mass spec ${ion} ${f(mz, 1)} → ${f(n.ms_m, 1)}, ${f(Math.abs(d), 1)} Da ${d > 0 ? 'above' : 'below'} the free peptide (${f(free, 2)}): check the formula sum, the ion form, or whether the m/z is of a fragment.`
    )
  }
  if (n.factor !== null) {
    const applied = Math.abs(n.factor - 1) > 1e-12
    parts.push(
      `Net factor = ${n.assay_pct === null ? '100' : f(n.assay_pct, 2)} % assay × f counterion ${f(n.f_counterion, 4)} × (1 - ${n.water_pct === null ? '0' : f(n.water_pct, 2)} % water) = ${f(n.factor, 4)}${
        applied
          ? `: net peptide = as weighed × ${f(n.factor, 3)}. The factor limits the precision: quote net values to 3 to 4 figures.`
          : ': nothing to correct yet.'
      }`
    )
  }
  if (worked.factor_source === 'override')
    parts.push(
      `The stock uses the factor entered by hand, ${f(worked.factor_applied, 4)}, in place of the one worked out.`
    )
  const sw = worked.stock_weight_mg
  if (worked.factor_applied !== null && sw !== null)
    parts.push(
      `Weighed ${f(sw, 2)} mg of standard → ${f(worked.stock_net_weight_mg, 2)} mg of peptide after the counterion, water and assay come off.`
    )
  return parts.join(' ')
}

const STEP1 = Object.fromEntries(STEP1_FIELDS.map(f => [f.key, f])) as Record<
  Step1Key,
  CalField<Step1Key>
>
const NET = Object.fromEntries(NET_FIELDS.map(f => [f.key, f])) as Record<
  NetKey,
  CalField<NetKey>
>

const COUNTERION_OPTIONS: [string, string][] = [
  ['', 'None'],
  ...Object.entries(COUNTERIONS).map(
    ([k, mw]) => [k, `${k} (${fmtDp(mw, 2)})`] as [string, string]
  ),
  ['Other', 'Other, type the mass'],
]
const ION_OPTIONS: [string, string][] = MS_IONS.map(i => [
  i,
  MS_ION_LABELS[i] ?? i,
])

/** Steps 1 and 1b: the standard and its net peptide weight. */
export function HplcCalStandardSection({
  inputs,
  worked,
  peptideId,
  instrumentId,
  peptides,
  instruments,
  names,
  replicate,
  filed,
  onSheet,
  onCommit,
  onRefused,
}: {
  inputs: CalInputs
  worked: CalWorked
  peptideId: number | null
  instrumentId: number | null
  peptides: PeptideRecord[]
  instruments: Instrument[]
  /** The stored peptide's and instrument's names, from the read model. */
  names: { peptide: string | null; instrument: string | null }
  replicate: boolean
  filed: boolean
  onSheet: (field: 'peptide_id' | 'instrument_id', id: number | null) => void
  onCommit: CalCommit
  onRefused: (key: string, on: boolean) => void
}) {
  const net = inputs.net ?? {}
  const lock = replicate
  const valueOf = (part: CalPart, key: string) =>
    ((part === 'net' ? net : inputs) as Record<string, unknown>)[key] ?? null
  const peptideOptions: [string, string][] = [
    ['', '-'],
    ...peptides
      .filter(p => !p.is_blend || p.id === peptideId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(p => [String(p.id), p.name] as [string, string]),
  ]
  const instrumentOptions: [string, string][] = [
    ['', '-'],
    ...instruments
      .filter(i => i.active || i.id === instrumentId)
      .map(i => [String(i.id), i.name] as [string, string]),
  ]
  // the sheet's own choice is always a choice, even before the lists load
  // or once it is retired, so the select never shows "-" for a set value
  const keep = (
    opts: [string, string][],
    id: number | null,
    name: string | null
  ) => {
    if (id !== null && !opts.some(([v]) => v === String(id)))
      opts.push([String(id), name ?? `#${id}`])
  }
  keep(peptideOptions, peptideId, names.peptide)
  keep(instrumentOptions, instrumentId, names.instrument)
  const num = (
    part: CalPart,
    key: string,
    f: CalField,
    extra?: { wide?: boolean }
  ) => (
    <CalNumberBox
      label={f.label}
      field={key}
      bound={key}
      value={valueOf(part, key) as number | null}
      placeholder={f.placeholder}
      disabled={lock}
      help={f.title}
      wide={extra?.wide}
      onCommit={v => onCommit(part, 0, key, v)}
      onRefused={on => onRefused(`${part}.${key}`, on)}
    />
  )
  const text = (
    part: CalPart,
    key: string,
    f: CalField,
    className?: string
  ) => (
    <CalTextBox
      label={f.label}
      value={valueOf(part, key) as string | null}
      placeholder={f.placeholder}
      disabled={lock}
      help={f.title}
      maxLength={key === 'assumption' ? 2000 : 200}
      className={className}
      onCommit={v => onCommit(part, 0, key, v)}
    />
  )
  const other = /^other$/i.test(String(net.counterion ?? ''))
  const summary = netSummary(worked, net)

  return (
    <>
      <Step
        no="Step 1"
        title="The standard"
        sub="What was bought, from the supplier's certificate. One standard per worksheet."
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
          <Cell field={STEP1.peptide_id}>
            <CalSelect
              label="Compound"
              value={peptideId === null ? '' : String(peptideId)}
              options={peptideOptions}
              disabled={replicate || filed}
              help={filed ? FILED_HELP : STEP1.peptide_id.title}
              minWidth="min-w-44"
              onChange={v => onSheet('peptide_id', v ? Number(v) : null)}
            />
          </Cell>
          <Cell field={STEP1.instrument_id}>
            <CalSelect
              label="Instrument"
              value={instrumentId === null ? '' : String(instrumentId)}
              options={instrumentOptions}
              disabled={filed}
              help={filed ? FILED_HELP : STEP1.instrument_id.title}
              onChange={v => onSheet('instrument_id', v ? Number(v) : null)}
            />
          </Cell>
          {(['standard_id', 'cas', 'supplier', 'lot'] as const).map(k => (
            <Cell key={k} field={STEP1[k]}>
              {text('sheet', k, STEP1[k])}
            </Cell>
          ))}
          {(
            [
              'coa_weight_mg',
              'diluent_density_mg_ml',
              'level_volume_ul',
            ] as const
          ).map(k => (
            <Cell key={k} field={STEP1[k]}>
              {num('sheet', k, STEP1[k], { wide: true })}
            </Cell>
          ))}
        </div>
      </Step>

      <Step
        no="Step 1b"
        title="Net peptide weight"
        sub="The balance weighs the salt: peptide + counterion + water, and the detector sees only the peptide. From the CoA: the free-peptide MW and the stated FW (the sheet checks whether the FW already includes the counterion), the counterion and its equivalents, the assay and the Karl Fischer water. The weighing is always adjusted: net peptide = weighed × assay × f counterion × (1 - water); with the block blank the factor is 1 until the CoA numbers go in. The same factor rescales every level, so R² does not move, only the concentrations. Write the counterion assumption in words; the curve cannot be filed without it."
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
          <Cell field={NET.counterion}>
            <CalSelect
              label="Counterion"
              value={String(net.counterion ?? '')}
              options={
                COUNTERION_OPTIONS.some(([v]) => v === (net.counterion ?? ''))
                  ? COUNTERION_OPTIONS
                  : [
                      ...COUNTERION_OPTIONS,
                      [String(net.counterion), String(net.counterion)],
                    ]
              }
              disabled={lock}
              help={NET.counterion.title}
              onChange={v => onCommit('net', 0, 'counterion', v || null)}
            />
          </Cell>
          {other && (
            <Cell field={NET.counterion_mw}>
              {num('net', 'counterion_mw', NET.counterion_mw, { wide: true })}
            </Cell>
          )}
          {(['equivalents', 'free_mw', 'stated_fw', 'ms_mz'] as const).map(
            k => (
              <Cell key={k} field={NET[k]}>
                {num('net', k, NET[k], { wide: true })}
              </Cell>
            )
          )}
          <Cell field={NET.ms_ion}>
            <CalSelect
              label="Ion"
              value={String(net.ms_ion ?? '')}
              options={ION_OPTIONS}
              disabled={lock}
              help={NET.ms_ion.title}
              minWidth="min-w-28"
              onChange={v => onCommit('net', 0, 'ms_ion', v || null)}
            />
          </Cell>
          {(['assay_pct', 'water_pct'] as const).map(k => (
            <Cell key={k} field={NET[k]}>
              {num('net', k, NET[k], { wide: true })}
            </Cell>
          ))}
          <div className="col-span-full">
            <Cell field={NET.assumption}>
              {text('net', 'assumption', NET.assumption, 'w-full max-w-xl')}
            </Cell>
          </div>
          <div className="col-span-full flex flex-wrap items-end gap-4 rounded-md border border-dashed p-2">
            <Cell field={NET.override_factor}>
              {num('net', 'override_factor', NET.override_factor)}
            </Cell>
            <div className="text-xs" data-testid="net-factors">
              <div>
                Worked out:{' '}
                <span className="font-mono">{fmtDp(worked.net.factor, 4)}</span>
              </div>
              {worked.factor_source === 'override' && (
                <div>
                  Used for the stock:{' '}
                  <span className="font-mono">
                    {fmtDp(worked.factor_applied, 4)}
                  </span>{' '}
                  (entered by hand)
                </div>
              )}
            </div>
            <div className="min-w-64 flex-1">
              <Cell field={NET.override_reason}>
                {text('net', 'override_reason', NET.override_reason, 'w-full')}
              </Cell>
            </div>
          </div>
        </div>
        {summary && (
          <p
            className="mt-3 text-xs text-muted-foreground"
            data-testid="net-summary"
          >
            {summary}
          </p>
        )}
      </Step>
    </>
  )
}
