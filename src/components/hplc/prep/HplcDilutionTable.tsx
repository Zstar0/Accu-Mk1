import type {
  HplcPrepVialInputs,
  HplcRowComputed,
  HplcVialComputed,
} from '@/lib/hplc-prep'
import { DEFAULT_DILUENT } from '@/lib/hplc-prep-rules'
import { TD } from '@/components/hplc/EndoWorksheetTable'
import type { SheetRowView, SheetSectionProps } from './HplcPrepSheet'
import {
  ComputedCell,
  fmtDp,
  HeadCell,
  Hint,
  IdCell,
  InputCell,
  NumberBox,
  SheetRow,
} from './HplcSheetCells'
import { STEP3_COLUMNS, type Step3Key } from './hplc-sheet-columns'
import { onSheetKey } from './hplc-sheet-keys'

const VIAL_LETTERS = 'ABCDEFG'

const LABEL = Object.fromEntries(
  STEP3_COLUMNS.map(c => [c.key, c.label])
) as Record<Step3Key, string>

/** Step 3: the dilution into the autosampler vial, one row per vial. */
export function HplcDilutionTable({ rowViews, onPatch }: SheetSectionProps) {
  return (
    <table className="w-full border-collapse" onKeyDown={onSheetKey}>
      <thead>
        <tr>
          {STEP3_COLUMNS.map(c => (
            <HeadCell key={c.key} col={c} />
          ))}
        </tr>
      </thead>
      <tbody>
        {rowViews.flatMap(v =>
          (v.computed?.vials ?? []).map(vial => (
            <SheetRow key={`${v.row.item_id}-${vial.vial}`} shaded={v.shaded}>
              {STEP3_COLUMNS.map(c => (
                <DilutionCell
                  key={c.key}
                  col={c.key}
                  view={v}
                  computed={v.computed as HplcRowComputed}
                  vial={vial}
                  onPatch={onPatch}
                />
              ))}
            </SheetRow>
          ))
        )}
      </tbody>
    </table>
  )
}

function DilutionCell({
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
  onPatch: SheetSectionProps['onPatch']
}) {
  const { row, locked } = view
  const n = String(vial.vial)
  const letter = VIAL_LETTERS[vial.vial - 1] ?? n
  const many = computed.vials.length > 1
  const typed: HplcPrepVialInputs = row.hplc_prep.vials?.[n] ?? {}
  const box = (
    key: keyof HplcPrepVialInputs,
    placeholder?: string,
    hint?: string | null
  ) => {
    const what = `${row.sample_id}, ${LABEL[col]}${many ? `, vial ${letter}` : ''}`
    return (
      <InputCell>
        <NumberBox
          label={what}
          field={col}
          value={typed[key]}
          placeholder={placeholder}
          disabled={locked}
          hint={hint}
          onCommit={v =>
            onPatch(
              row.item_id,
              { hplc_prep: { vials: { [n]: { [key]: v } } } },
              what
            )
          }
        />
      </InputCell>
    )
  }
  const warn = (code: string) =>
    computed.warnings.find(w => w.code === code && w.vial === vial.vial)?.text
  switch (col) {
    case 'sample_id':
      return (
        <IdCell>
          {row.sample_id}
          {many && ` ${letter}`}
          {vial.two_step && (
            <Hint>two-step: dilutes from its intermediate vial (Step 3a)</Hint>
          )}
        </IdCell>
      )
    case 'identity':
      return <VialIdentityCell view={view} vial={vial} />
    case 'diluent':
      return <DiluentCell computed={computed} />
    case 'stock_for_final':
      return <ComputedCell value={vial.stock_for_final} dp={2} />
    case 'target_ug_ml':
      return box('target_ug_ml', fmtDp(vial.target.value, 0))
    case 'target_volume_ul':
      return box('target_volume_ul', String(row.params.target_volume_ul))
    case 'vial_mg':
      return box('vial_mg')
    case 'diluent_vol_ul':
      return <ComputedCell value={vial.plan.diluent_vol_ul} dp={2} />
    case 'diluent_half_ul':
      return <ComputedCell value={vial.plan.diluent_half_ul} dp={2} />
    case 'vial_diluent_mg':
      return box(
        'vial_diluent_mg',
        undefined,
        vial.neat ? 'neat, no diluent; blank = the vial weight' : null
      )
    case 'stock_vol_ul':
      return <ComputedCell value={vial.plan.stock_vol_ul} dp={2} />
    case 'stock_half_ul':
      return <ComputedCell value={vial.plan.stock_half_ul} dp={2} />
    case 'vial_all_mg':
      return box('vial_all_mg')
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

/** Which peptides a vial holds (Steps 3 and 3a). */
export function VialIdentityCell({
  view,
  vial,
}: {
  view: SheetRowView
  vial: HplcVialComputed
}) {
  return (
    <td className={TD}>
      {vial.component_ids
        .map(
          id =>
            view.row.components.find(c => c.peptide_id === id)?.name ??
            `peptide #${id}`
        )
        .join(' + ')}
    </td>
  )
}

/** The row's diluent, marked when it is not plain water (Steps 3 and 3a). */
export function DiluentCell({ computed }: { computed: HplcRowComputed }) {
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
