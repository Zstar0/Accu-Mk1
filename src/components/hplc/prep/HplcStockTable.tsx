import type { HplcSheetRow } from '@/lib/api'
import type { HplcRowComputed } from '@/lib/hplc-prep'
import {
  HPLC_DILUENTS,
  matchRule,
  rowDiluent,
  rowInstrument,
} from '@/lib/hplc-prep-rules'
import { TD, TH } from '@/components/hplc/EndoWorksheetTable'
import type {
  HplcPrepSheetProps,
  SheetRowView,
  SheetSectionProps,
} from './HplcPrepSheet'
import {
  CellSelect,
  ComputedCell,
  fmtDp,
  HeadCell,
  Hint,
  IdCell,
  InputCell,
  NumberBox,
  SheetRow,
} from './HplcSheetCells'
import { FORM_LABELS, STEP2_COLUMNS, type Step2Key } from './hplc-sheet-columns'
import { onSheetKey } from './hplc-sheet-keys'
import { boxKey } from '@/services/hplc-worksheet'

const LABEL = Object.fromEntries(
  STEP2_COLUMNS.map(c => [c.key, c.label])
) as Record<Step2Key, string>

/** A box's accessible name: "<sample id>, <column label>". */
const nameOf = (row: HplcSheetRow, col: Step2Key) =>
  `${row.sample_id}, ${LABEL[col]}`

/** Step 2: the stock preparation, one row per sample. */
export function HplcStockTable(props: SheetSectionProps) {
  const { rowViews, step2Trailing } = props
  const any = (form: string) => rowViews.some(v => v.row.form === form)
  const cols = STEP2_COLUMNS.filter(c => !c.only || any(c.only))
  return (
    <table className="w-full border-collapse" onKeyDown={onSheetKey}>
      <thead>
        <tr>
          {cols.map(c => (
            <HeadCell key={c.key} col={c} />
          ))}
          {step2Trailing && <th className={TH}>{step2Trailing.header}</th>}
        </tr>
      </thead>
      <tbody>
        {rowViews.map(v => (
          <SheetRow key={v.row.item_id} shaded={v.shaded}>
            {v.computed ? (
              cols.map(c => (
                <StockCell
                  key={c.key}
                  {...props}
                  col={c.key}
                  view={v}
                  computed={v.computed as HplcRowComputed}
                />
              ))
            ) : (
              <UnplannedCells
                view={v}
                cols={cols.length}
                onPatch={props.onPatch}
              />
            )}
            {step2Trailing && <td className={TD}>{step2Trailing.cell(v)}</td>}
          </SheetRow>
        ))}
      </tbody>
    </table>
  )
}

const identityOf = (row: HplcSheetRow) =>
  row.identity ?? row.peptide_name ?? '-'

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
  const what = nameOf(row, 'form')
  return (
    <CellSelect
      label={what}
      field="form"
      saveKey={boxKey(row.item_id, 'prep_form')}
      value={row.prep_form ?? ''}
      disabled={view.locked}
      options={[
        ['', `from the sample (${own ? FORM_LABELS[own] : 'no HPLC prep'})`],
        ...Object.entries(FORM_LABELS),
      ]}
      onChange={v =>
        onPatch(
          row.item_id,
          { prep_form: v === '' ? null : (v as HplcSheetRow['form']) },
          what
        )
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
      <IdCell>{row.sample_id}</IdCell>
      <td className={TD}>{identityOf(row)}</td>
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

function StockCell({
  col,
  view,
  computed,
  rules,
  instruments,
  onPatch,
  onSetInstrument,
}: SheetSectionProps & {
  col: Step2Key
  view: SheetRowView
  computed: HplcRowComputed
}) {
  const { row, locked } = view
  const inputs = row.hplc_prep
  const form = row.form
  const bac = form === 'bac'
  const liquid = form === 'liquid'
  const capsule = form === 'capsule'
  const what = nameOf(row, col)
  const set = (key: string, v: unknown) =>
    onPatch(row.item_id, { hplc_prep: { [key]: v } }, what)
  const keyOf = (key: string) => boxKey(row.item_id, `hplc_prep.${key}`)
  // The row's own rule line, as computeRow matches it, for the "by rule"
  // diluent and the usual instrument.
  const ruleQ = {
    rowRule: matchRule(rules, {
      peptideId: row.peptide_id,
      weightMg: computed.declared_total_mg,
    }),
    components: row.components,
  }
  // On a bac row the two weighing boxes trade cells (below); each is named
  // for the column it is in.
  const weighBox = (
    key: 'stock_vial_mg' | 'stock_vial_diluent_mg',
    hint: string | null
  ) => (
    <NumberBox
      label={what}
      field={col}
      saveKey={keyOf(key)}
      value={inputs[key]}
      disabled={locked || liquid}
      hint={hint}
      onCommit={v => set(key, v)}
    />
  )
  switch (col) {
    case 'sample_id':
      return <IdCell>{row.sample_id}</IdCell>
    case 'identity':
      return (
        <td className={TD}>
          {identityOf(row)}
          {row.is_blend && row.components_source === 'analyses' && (
            <Hint>
              components from the tests ordered; type each weight in Step 2b
            </Hint>
          )}
        </td>
      )
    case 'declared_mg':
      // A bac row's declared weight is worked out from the volume, not typed.
      return bac ? (
        <ComputedCell
          value={computed.declared_total_mg}
          dp={2}
          title={
            computed.declared_total_mg === null
              ? 'Weigh the vial full (① the left box), then emptied and dried (② the right box): the declared weight is 9 mg/mL × the volume'
              : `Worked out: ${fmtDp(computed.stock.total_diluent_ml, 4)} mL × 9 mg/mL (0.9% benzyl alcohol).`
          }
        >
          <Hint>9 mg/mL × the volume (0.9% benzyl alcohol)</Hint>
        </ComputedCell>
      ) : (
        <InputCell>
          <NumberBox
            label={what}
            field={col}
            saveKey={keyOf('declared_mg')}
            value={inputs.declared_mg}
            placeholder={
              row.declared_mg === null ? undefined : String(row.declared_mg)
            }
            disabled={locked}
            hint={capsule ? 'per capsule' : row.is_blend ? 'vial total' : null}
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
              label={what}
              field={col}
              saveKey={keyOf('declared_volume_ml')}
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
              label={what}
              field={col}
              saveKey={keyOf('capsules')}
              integer
              value={inputs.capsules}
              disabled={locked}
              hint={
                inputs.capsules && inputs.capsules > 0
                  ? `${fmtDp(computed.declared_total_mg, 2)} mg of peptide in the stock`
                  : 'how many capsules?'
              }
              onCommit={v => set('capsules', v)}
            />
          )}
        </InputCell>
      )
    case 'instrument': {
      const usual =
        row.instrument_id === null ? rowInstrument(rules, ruleQ) : null
      const named = (id: number) =>
        instruments.find(i => i.id === id)?.name ?? `instrument #${id}`
      const listed = instruments.some(i => i.id === row.instrument_id)
      return (
        <td className={TD}>
          <CellSelect
            label={what}
            field={col}
            saveKey={boxKey(row.item_id, 'instrument_id')}
            value={row.instrument_id === null ? '' : String(row.instrument_id)}
            disabled={locked}
            options={[
              ['', 'not set'],
              // the rule's usual instrument, as a choice that writes it
              ...(usual === null
                ? []
                : [
                    [String(usual), `usually ${named(usual)}`] as [
                      string,
                      string,
                    ],
                  ]),
              ...(row.instrument_id !== null && !listed
                ? [
                    [
                      String(row.instrument_id),
                      row.instrument_name ?? named(row.instrument_id),
                    ] as [string, string],
                  ]
                : []),
              ...instruments.map(
                i => [String(i.id), i.name] as [string, string]
              ),
            ]}
            onChange={v =>
              onSetInstrument(row.item_id, v === '' ? null : Number(v), what)
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
            label={what}
            field={col}
            saveKey={keyOf('diluent')}
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
                '① full, as received: weigh first'
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
            ? weighBox('stock_vial_mg', '② emptied and dried: weigh after')
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
            label={what}
            field={col}
            saveKey={keyOf('diluent_ul')}
            value={inputs.diluent_ul}
            placeholder={assumed === null ? undefined : fmtDp(assumed, 0)}
            // none of ours goes into a liquid or bac vial
            disabled={locked || liquid || bac}
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
    case 'total_diluent_ml': {
      const total = computed.stock.total_diluent_ml
      const hint = liquid
        ? total === null
          ? 'needs the declared volume'
          : 'the declared volume'
        : bac
          ? 'bac water in the vial, corrected for 0.9% benzyl alcohol'
          : null
      return (
        <ComputedCell value={total} dp={4}>
          {hint && <Hint>{hint}</Hint>}
        </ComputedCell>
      )
    }
    case 'stock_conc': {
      const total = computed.stock.total_diluent_ml
      const hint =
        liquid && total !== null
          ? `in the declared ${fmtDp(total, 2)} mL`
          : bac
            ? '0.9% benzyl alcohol, fixed'
            : null
      return (
        <ComputedCell value={computed.vials[0]?.stock_conc_ug_ml} dp={2}>
          {hint && <Hint>{hint}</Hint>}
        </ComputedCell>
      )
    }
    case 'two_step':
      return (
        <td className={TD}>
          <CellSelect
            label={what}
            field={col}
            saveKey={keyOf('two_step')}
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
