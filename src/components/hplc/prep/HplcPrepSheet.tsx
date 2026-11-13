import type { ReactNode } from 'react'
import type {
  HplcRowPatch,
  HplcSheet,
  HplcSheetRow,
  Instrument,
} from '@/lib/api'
import {
  computeRow,
  type HplcPrepVialInputs,
  type HplcRowComputed,
  type HplcVialComputed,
} from '@/lib/hplc-prep'
import {
  DEFAULT_DILUENT,
  HPLC_DILUENTS,
  matchRule,
  rowDiluent,
  rowInstrument,
  type HplcPrepRule,
} from '@/lib/hplc-prep-rules'
import { MONO, TD, TH, TH_CALC } from '@/components/hplc/EndoWorksheetTable'
import {
  CellSelect,
  ComputedCell,
  fmtDp,
  Hint,
  InputCell,
  NumberBox,
} from './HplcSheetCells'
import {
  FORM_LABELS,
  STEP2_COLUMNS,
  STEP2_SUB,
  STEP2_TITLE,
  STEP3_COLUMNS,
  STEP3_SUB,
  STEP3_TITLE,
  type SheetColumn,
  type Step2Key,
  type Step3Key,
} from './hplc-sheet-columns'

/** One row as the sheet shows it: its facts, what computeRow made of them
 *  (null when the row cannot be planned), and whether it can be edited. */
export interface SheetRowView {
  row: HplcSheetRow
  computed: HplcRowComputed | null
  locked: boolean
  /** On another instrument than the first row's: shaded, as the source
   *  shades its 1290B rows. */
  shaded: boolean
}

export interface HplcPrepSheetProps {
  sheet: HplcSheet
  rules: HplcPrepRule[]
  readOnly: boolean
  instruments: Pick<Instrument, 'id' | 'name'>[]
  onPatch: (itemId: number, patch: HplcRowPatch) => void
  onSetInstrument: (itemId: number, instrumentId: number | null) => void
  /** Task 9's promote control. */
  onPromote?: (itemId: number) => void
  /** A column after Step 2's last (Task 9's promote control). */
  step2Trailing?: { header: ReactNode; cell: (v: SheetRowView) => ReactNode }
}

const VIAL_LETTERS = 'ABCDEFG'

/** computeRow throws on a row with a form and no components; a rider (a
 *  fentanyl vial) has no prep of its own. */
const plannable = (row: HplcSheetRow) =>
  row.form !== null && row.components.length > 0 && !row.rider_only

// Task 8's Step 2b and 3a tables read the same rows; Fast Refresh on this
// file only.
// eslint-disable-next-line react-refresh/only-export-components
export function sheetRowViews(
  sheet: HplcSheet,
  rules: HplcPrepRule[],
  readOnly: boolean
): SheetRowView[] {
  const first = sheet.rows[0]?.instrument_id ?? null
  return sheet.rows.map(row => ({
    row,
    computed: plannable(row)
      ? computeRow(row, row.hplc_prep, rules, row.params)
      : null,
    locked: readOnly || row.promoted,
    shaded: row.instrument_id !== first,
  }))
}

/**
 * The HPLC prep sheet: the warnings, then the source's step sections in its
 * order. Presentational: every figure comes from computeRow, every edit goes
 * out through onPatch (one merge patch per cell) or onSetInstrument.
 */
export function HplcPrepSheet(props: HplcPrepSheetProps) {
  const views = sheetRowViews(props.sheet, props.rules, props.readOnly)
  // In the source's order; Task 8 adds Step 2b after Step 2 and Step 3a
  // before Step 3.
  const sections: { id: string; node: ReactNode }[] = [
    { id: 'warnings', node: <WarningsPanel views={views} /> },
    {
      id: 'step2',
      node: (
        <Section step="Step 2" title={STEP2_TITLE} sub={STEP2_SUB}>
          <Step2Table {...props} views={views} />
        </Section>
      ),
    },
    {
      id: 'step3',
      node: (
        <Section step="Step 3" title={STEP3_TITLE} sub={STEP3_SUB}>
          <Step3Table views={views} onPatch={props.onPatch} />
        </Section>
      ),
    },
  ]
  return (
    <div className="space-y-6">
      {sections.map(s => (
        <div key={s.id}>{s.node}</div>
      ))}
    </div>
  )
}

function WarningsPanel({ views }: { views: SheetRowView[] }) {
  const lines = views.flatMap(v =>
    (v.computed?.warnings ?? []).map(w => `${v.row.sample_id}: ${w.text}`)
  )
  if (!lines.length) return null
  return (
    <section
      aria-label="Warnings"
      className="rounded-[5px] border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-800 dark:text-amber-200"
    >
      <ul className="list-disc space-y-1 pl-4">
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </section>
  )
}

function Section({
  step,
  title,
  sub,
  children,
}: {
  step: string
  title: string
  sub: string
  children: ReactNode
}) {
  return (
    <section
      aria-label={`${step} ${title}`}
      className="overflow-hidden rounded-[5px] border bg-card shadow-sm"
    >
      <div className="border-b px-4 py-3">
        <h3 className="text-[15px] font-semibold">
          <span className="mr-2 text-teal-600 dark:text-teal-400">{step}</span>
          {title}
        </h3>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}

function HeadCell({ col }: { col: SheetColumn }) {
  return (
    <th
      title={col.title}
      className={`${TH} ${col.kind === 'computed' ? TH_CALC : ''} whitespace-normal`}
    >
      {col.label}
    </th>
  )
}

const ROW_SHADE = 'bg-sky-500/[0.07]'

// ---------------------------------------------------------------- Step 2

function Step2Table({
  views,
  rules,
  instruments,
  onPatch,
  onSetInstrument,
  step2Trailing,
}: HplcPrepSheetProps & { views: SheetRowView[] }) {
  const any = (form: string) => views.some(v => v.row.form === form)
  const cols = STEP2_COLUMNS.filter(c => !c.only || any(c.only))
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          {cols.map(c => (
            <HeadCell key={c.key} col={c} />
          ))}
          {step2Trailing && <th className={TH}>{step2Trailing.header}</th>}
        </tr>
      </thead>
      <tbody>
        {views.map(v => (
          <tr key={v.row.item_id} className={v.shaded ? ROW_SHADE : ''}>
            {v.computed ? (
              cols.map(c => (
                <Step2Cell
                  key={c.key}
                  col={c.key}
                  view={v}
                  computed={v.computed as HplcRowComputed}
                  rules={rules}
                  instruments={instruments}
                  onPatch={onPatch}
                  onSetInstrument={onSetInstrument}
                />
              ))
            ) : (
              <UnplannedCells view={v} cols={cols.length} onPatch={onPatch} />
            )}
            {step2Trailing && <td className={TD}>{step2Trailing.cell(v)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The sample's own form, when the row does not pick one. */
function sampleOwnForm(row: HplcSheetRow): string | null {
  return row.sample_bac ? 'bac' : (row.sample_form?.hplc_prep ?? null)
}

function FormSelect({
  view,
  onPatch,
}: {
  view: SheetRowView
  onPatch: HplcPrepSheetProps['onPatch']
}) {
  const { row } = view
  const own = sampleOwnForm(row)
  return (
    <CellSelect
      label="Form"
      value={row.prep_form ?? ''}
      disabled={view.locked}
      options={[
        ['', `from the sample (${own ? FORM_LABELS[own] : 'no HPLC prep'})`],
        ...Object.entries(FORM_LABELS),
      ]}
      onChange={v =>
        onPatch(row.item_id, {
          prep_form: v === '' ? null : (v as HplcSheetRow['form']),
        })
      }
    />
  )
}

/** A row computeRow cannot plan: its id, identity and form, and why. */
function UnplannedCells({
  view,
  cols,
  onPatch,
}: {
  view: SheetRowView
  cols: number
  onPatch: HplcPrepSheetProps['onPatch']
}) {
  const { row } = view
  const why = [
    row.form === null ? 'no HPLC prep for this form' : null,
    ...row.problems,
  ].filter(Boolean)
  return (
    <>
      <td className={`${TD} ${MONO}`}>{row.sample_id}</td>
      <td className={TD}>{row.identity ?? '-'}</td>
      <td className={TD} />
      <td className={TD}>
        {!row.rider_only && <FormSelect view={view} onPatch={onPatch} />}
      </td>
      <td className={`${TD} text-muted-foreground`} colSpan={cols - 4}>
        {why.length ? why.join('. ') : 'no HPLC prep for this row'}
      </td>
    </>
  )
}

function Step2Cell({
  col,
  view,
  computed,
  rules,
  instruments,
  onPatch,
  onSetInstrument,
}: {
  col: Step2Key
  view: SheetRowView
  computed: HplcRowComputed
  rules: HplcPrepRule[]
  instruments: HplcPrepSheetProps['instruments']
  onPatch: HplcPrepSheetProps['onPatch']
  onSetInstrument: HplcPrepSheetProps['onSetInstrument']
}) {
  const { row, locked } = view
  const inputs = row.hplc_prep
  const form = row.form
  const bac = form === 'bac'
  const liquid = form === 'liquid'
  const capsule = form === 'capsule'
  const set = (key: string, v: unknown) =>
    onPatch(row.item_id, { hplc_prep: { [key]: v } })
  // The row's own rule line, as computeRow matches it, for the "by rule"
  // diluent and the usual instrument.
  const ruleQ = {
    rowRule: matchRule(rules, {
      peptideId: row.peptide_id,
      weightMg: computed.declared_total_mg,
    }),
    components: row.components,
  }
  const weighBox = (
    key: 'stock_vial_mg' | 'stock_vial_diluent_mg',
    hint: string | null
  ) => (
    <NumberBox
      label={
        key === 'stock_vial_mg'
          ? 'Wt Customer Sample vial and Septum'
          : 'Wt Customer Sample vial and Septum + Diluent'
      }
      value={inputs[key]}
      disabled={locked || liquid}
      hint={hint}
      onCommit={v => set(key, v)}
    />
  )
  switch (col) {
    case 'sample_id':
      return <td className={`${TD} ${MONO}`}>{row.sample_id}</td>
    case 'identity':
      return (
        <td className={TD}>
          {row.identity ?? '-'}
          {row.is_blend && row.components_source === 'analyses' && (
            <Hint>
              components from the tests ordered; type each weight in Step 2b
            </Hint>
          )}
        </td>
      )
    case 'declared_mg':
      return (
        <InputCell>
          <NumberBox
            label="Declared Peptide Wt"
            value={inputs.declared_mg}
            placeholder={
              row.declared_mg === null ? undefined : String(row.declared_mg)
            }
            disabled={locked}
            hint={
              bac
                ? '9 mg/mL × the volume (0.9% benzyl alcohol)'
                : capsule
                  ? 'per capsule'
                  : row.is_blend
                    ? 'vial total'
                    : null
            }
            onCommit={v => set('declared_mg', v)}
          />
        </InputCell>
      )
    case 'form':
      return (
        <td className={TD}>
          <FormSelect view={view} onPatch={onPatch} />
        </td>
      )
    case 'declared_volume_ml':
      return (
        <InputCell>
          {liquid && (
            <NumberBox
              label="Declared Liquid Vol"
              value={inputs.declared_volume_ml}
              disabled={locked}
              hint={
                computed.stock.total_diluent_ml === null
                  ? 'type the declared volume'
                  : 'taken as declared'
              }
              onCommit={v => set('declared_volume_ml', v)}
            />
          )}
        </InputCell>
      )
    case 'capsules':
      return (
        <InputCell>
          {capsule && (
            <NumberBox
              label="Capsules used"
              integer
              value={inputs.capsules}
              disabled={locked}
              hint={inputs.capsules ? null : 'how many capsules?'}
              onCommit={v => set('capsules', v)}
            />
          )}
        </InputCell>
      )
    case 'instrument': {
      const usual =
        row.instrument_id === null ? rowInstrument(rules, ruleQ) : null
      const nameOf = (id: number) =>
        instruments.find(i => i.id === id)?.name ?? `instrument #${id}`
      const listed = instruments.some(i => i.id === row.instrument_id)
      return (
        <td className={TD}>
          <CellSelect
            label="Instrument"
            value={row.instrument_id === null ? '' : String(row.instrument_id)}
            disabled={locked}
            options={[
              ['', usual === null ? '-' : `usually ${nameOf(usual)}`],
              ...(row.instrument_id !== null && !listed
                ? [
                    [
                      String(row.instrument_id),
                      row.instrument_name ?? nameOf(row.instrument_id),
                    ] as [string, string],
                  ]
                : []),
              ...instruments.map(
                i => [String(i.id), i.name] as [string, string]
              ),
            ]}
            onChange={v =>
              onSetInstrument(row.item_id, v === '' ? null : Number(v))
            }
          />
        </td>
      )
    }
    case 'diluent': {
      const typed = typeof inputs.diluent === 'string' ? inputs.diluent : ''
      const choices: string[] = [...HPLC_DILUENTS]
      if (typed && !choices.includes(typed)) choices.push(typed)
      return (
        <td className={TD}>
          <CellSelect
            label="Diluent"
            value={typed}
            disabled={locked}
            options={[
              ['', `by rule (${rowDiluent(rules, ruleQ).diluent})`],
              ...choices.map(d => [d, d] as [string, string]),
            ]}
            onChange={v => set('diluent', v === '' ? null : v)}
          />
        </td>
      )
    }
    // A bac vial is weighed full first, then emptied and dried; as on the
    // source sheet, its two boxes trade cells so the left one takes the full
    // weight (stock_vial_diluent_mg) and the right one the dried vial.
    case 'stock_vial_mg':
      return (
        <InputCell>
          {bac
            ? weighBox(
                'stock_vial_diluent_mg',
                '(1) full, as received: weigh first'
              )
            : weighBox(
                'stock_vial_mg',
                capsule ? 'the vial + cap with the capsules emptied in' : null
              )}
        </InputCell>
      )
    case 'stock_vial_diluent_mg':
      return (
        <InputCell>
          {bac
            ? weighBox('stock_vial_mg', '(2) emptied and dried: weigh after')
            : weighBox(
                'stock_vial_diluent_mg',
                capsule ? 'the same vial after the water' : null
              )}
        </InputCell>
      )
    case 'diluent_ul': {
      const assumed = capsule
        ? computed.capsule_diluent_ul
        : row.params.sample_diluent_ul
      const target = computed.vials[0]?.target.value ?? null
      return (
        <InputCell>
          <NumberBox
            label="Diluent to add"
            value={inputs.diluent_ul}
            placeholder={assumed === null ? undefined : fmtDp(assumed, 0)}
            disabled={locked}
            hint={
              !capsule
                ? null
                : computed.capsule_diluent_ul === null
                  ? 'needs the capsules count'
                  : inputs.diluent_ul == null
                    ? `assumed: water to make the stock ${fmtDp(target, 0)} ug/mL`
                    : `typed; ${fmtDp(computed.capsule_diluent_ul, 0)} uL would make the stock ${fmtDp(target, 0)} ug/mL`
            }
            onCommit={v => set('diluent_ul', v)}
          />
        </InputCell>
      )
    }
    case 'total_diluent_ml':
      return (
        <ComputedCell value={computed.stock.total_diluent_ml} dp={4}>
          {bac && (
            <Hint>
              bac water in the vial, corrected for 0.9% benzyl alcohol
            </Hint>
          )}
        </ComputedCell>
      )
    case 'stock_conc':
      return <ComputedCell value={computed.vials[0]?.stock_conc_ug_ml} dp={2} />
    case 'two_step':
      return (
        <td className={TD}>
          <CellSelect
            label="2-step dilution"
            value={
              typeof inputs.two_step === 'boolean'
                ? String(inputs.two_step)
                : ''
            }
            disabled={locked}
            options={[
              ['', 'auto'],
              ['true', 'yes'],
              ['false', 'no'],
            ]}
            onChange={v => set('two_step', v === '' ? null : v === 'true')}
          />
        </td>
      )
  }
}

// ---------------------------------------------------------------- Step 3

function Step3Table({
  views,
  onPatch,
}: {
  views: SheetRowView[]
  onPatch: HplcPrepSheetProps['onPatch']
}) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          {STEP3_COLUMNS.map(c => (
            <HeadCell key={c.key} col={c} />
          ))}
        </tr>
      </thead>
      <tbody>
        {views.flatMap(v =>
          (v.computed?.vials ?? []).map(vial => (
            <tr
              key={`${v.row.item_id}-${vial.vial}`}
              className={v.shaded ? ROW_SHADE : ''}
            >
              {STEP3_COLUMNS.map(c => (
                <Step3Cell
                  key={c.key}
                  col={c.key}
                  view={v}
                  computed={v.computed as HplcRowComputed}
                  vial={vial}
                  onPatch={onPatch}
                />
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  )
}

function Step3Cell({
  col,
  view,
  computed,
  vial,
  onPatch,
}: {
  col: Step3Key
  view: SheetRowView
  computed: HplcRowComputed
  vial: HplcVialComputed
  onPatch: HplcPrepSheetProps['onPatch']
}) {
  const { row, locked } = view
  const n = String(vial.vial)
  const typed: HplcPrepVialInputs = row.hplc_prep.vials?.[n] ?? {}
  const box = (
    key: keyof HplcPrepVialInputs,
    label: string,
    placeholder?: string,
    hint?: string | null
  ) => (
    <InputCell>
      <NumberBox
        label={label}
        value={typed[key]}
        placeholder={placeholder}
        disabled={locked}
        hint={hint}
        onCommit={v =>
          onPatch(row.item_id, { hplc_prep: { vials: { [n]: { [key]: v } } } })
        }
      />
    </InputCell>
  )
  const warn = (code: string) =>
    computed.warnings.find(w => w.code === code && w.vial === vial.vial)?.text
  switch (col) {
    case 'sample_id':
      return (
        <td className={`${TD} ${MONO}`}>
          {row.sample_id}
          {computed.vials.length > 1 &&
            ` ${VIAL_LETTERS[vial.vial - 1] ?? vial.vial}`}
          {vial.two_step && (
            <Hint>
              two-step: its intermediate vial (Step 3a) is not on the sheet yet
            </Hint>
          )}
        </td>
      )
    case 'identity':
      return (
        <td className={TD}>
          {vial.component_ids
            .map(
              id =>
                row.components.find(c => c.peptide_id === id)?.name ??
                `peptide #${id}`
            )
            .join(' + ')}
        </td>
      )
    case 'diluent': {
      const d = computed.diluent.diluent
      return (
        <td className={TD}>
          {d !== null && d !== DEFAULT_DILUENT ? (
            <span className="rounded-[3px] bg-amber-500/15 px-1.5 py-px text-amber-700 dark:text-amber-300">
              {d}
            </span>
          ) : (
            (d ?? '-')
          )}
        </td>
      )
    }
    case 'stock_for_final':
      return <ComputedCell value={vial.stock_for_final} dp={2} />
    case 'target_ug_ml':
      return box('target_ug_ml', 'Target Conc', fmtDp(vial.target.value, 0))
    case 'target_volume_ul':
      return box(
        'target_volume_ul',
        'Target Total Vol',
        String(row.params.target_volume_ul)
      )
    case 'vial_mg':
      return box('vial_mg', 'Wt Autosampler vial and cap')
    case 'diluent_vol_ul':
      return <ComputedCell value={vial.plan.diluent_vol_ul} dp={2} />
    case 'diluent_half_ul':
      return <ComputedCell value={vial.plan.diluent_half_ul} dp={2} />
    case 'vial_diluent_mg':
      return box(
        'vial_diluent_mg',
        'Wt Autosampler vial and cap + Diluent',
        undefined,
        vial.neat ? 'neat, no diluent; blank = the vial weight' : null
      )
    case 'stock_vol_ul':
      return <ComputedCell value={vial.plan.stock_vol_ul} dp={2} />
    case 'stock_half_ul':
      return <ComputedCell value={vial.plan.stock_half_ul} dp={2} />
    case 'vial_all_mg':
      return box('vial_all_mg', 'Wt of Vial, cap, Diluent + Sample')
    case 'actual_diluent_ul':
      return (
        <ComputedCell
          value={vial.actual.actual_diluent_ul}
          dp={2}
          mark={vial.off.diluent}
          markTitle={warn('step3_diluent')}
        />
      )
    case 'actual_stock_ul':
      return (
        <ComputedCell
          value={vial.actual.actual_stock_ul}
          dp={2}
          mark={vial.off.stock}
          markTitle={warn('step3_stock')}
        />
      )
    case 'actual_total_ul':
      return <ComputedCell value={vial.actual.actual_total_ul} dp={2} />
    case 'actual_conc_ug_ml':
      return <ComputedCell value={vial.actual.actual_conc_ug_ml} dp={2} />
    case 'dilution_factor_total':
      return <ComputedCell value={vial.dilution_factor_total} dp={4} />
  }
}

export default HplcPrepSheet
