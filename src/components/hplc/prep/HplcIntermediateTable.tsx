import type {
  HplcIntermediate,
  HplcPrepVialInputs,
  HplcRowComputed,
  HplcVialComputed,
} from '@/lib/hplc-prep'
import type { SheetRowView, SheetSectionProps } from './HplcPrepSheet'
import { DiluentCell, VialIdentityCell } from './HplcDilutionTable'
import {
  ComputedCell,
  fmtDp,
  HeadCell,
  IdCell,
  InputCell,
  NumberBox,
  SheetRow,
} from './HplcSheetCells'
import {
  STEP3A_COLUMNS,
  VIAL_LETTERS,
  type Step3aKey,
} from './hplc-sheet-columns'
import { onSheetKey } from './hplc-sheet-keys'

const LABEL = Object.fromEntries(
  STEP3A_COLUMNS.map(c => [c.key, c.label])
) as Record<Step3aKey, string>

/** Step 3a: the intermediate vial, one row per vial that takes two steps. */
export function HplcIntermediateTable({
  rowViews,
  onPatch,
}: SheetSectionProps) {
  return (
    <table className="w-full border-collapse" onKeyDown={onSheetKey}>
      <thead>
        <tr>
          {STEP3A_COLUMNS.map(c => (
            <HeadCell key={c.key} col={c} />
          ))}
        </tr>
      </thead>
      <tbody>
        {rowViews.flatMap(v =>
          (v.computed?.vials ?? []).flatMap(vial =>
            vial.intermediate === null
              ? []
              : [
                  <SheetRow
                    key={`${v.row.item_id}-${vial.vial}`}
                    shaded={v.shaded}
                  >
                    {STEP3A_COLUMNS.map(c => (
                      <IntermediateCell
                        key={c.key}
                        col={c.key}
                        view={v}
                        computed={v.computed as HplcRowComputed}
                        vial={vial}
                        inter={vial.intermediate as HplcIntermediate}
                        onPatch={onPatch}
                      />
                    ))}
                  </SheetRow>,
                ]
          )
        )}
      </tbody>
    </table>
  )
}

function IntermediateCell({
  col,
  view,
  computed,
  vial,
  inter,
  onPatch,
}: {
  col: Step3aKey
  view: SheetRowView
  computed: HplcRowComputed
  vial: HplcVialComputed
  inter: HplcIntermediate
  onPatch: SheetSectionProps['onPatch']
}) {
  const { row, locked } = view
  const n = String(vial.vial)
  const letter = VIAL_LETTERS[vial.vial - 1] ?? n
  const many = computed.vials.length > 1
  const typed: HplcPrepVialInputs = row.hplc_prep.vials?.[n] ?? {}
  const box = (key: keyof HplcPrepVialInputs, placeholder?: string) => {
    const what = `${row.sample_id}, ${LABEL[col]}${many ? `, vial ${letter}` : ''}`
    // the target and volume: 0 or less means "the standard", as on the
    // source sheet
    const clears = key === 'int_target_ug_ml' || key === 'int_volume_ul'
    return (
      <InputCell>
        <NumberBox
          label={what}
          field={col}
          value={typed[key]}
          placeholder={placeholder}
          disabled={locked}
          onCommit={v =>
            onPatch(
              row.item_id,
              {
                hplc_prep: {
                  vials: {
                    [n]: { [key]: clears && v !== null && v <= 0 ? null : v },
                  },
                },
              },
              what
            )
          }
        />
      </InputCell>
    )
  }
  // the volume_off warning for this vial's intermediate, with its numbers
  const offText = (what: 'stock' | 'diluent') =>
    computed.warnings.find(
      w =>
        w.code === 'volume_off' &&
        w.vial === vial.vial &&
        w.text.includes(`the ${what} added to the intermediate`)
    )?.text
  switch (col) {
    case 'sample_id':
      return (
        <IdCell>
          {row.sample_id}
          {many && ` ${letter}`}
        </IdCell>
      )
    case 'identity':
      return <VialIdentityCell view={view} vial={vial} />
    case 'diluent':
      return <DiluentCell computed={computed} />
    case 'int_target_ug_ml':
      return box(
        'int_target_ug_ml',
        inter.target_ug_ml === null ? undefined : fmtDp(inter.target_ug_ml, 0)
      )
    case 'int_volume_ul':
      return box('int_volume_ul', String(row.params.intermediate_volume_ul))
    case 'int_vial_mg':
      return box('int_vial_mg')
    case 'diluent_vol_ul':
      return <ComputedCell value={inter.plan.diluent_vol_ul} dp={2} />
    case 'diluent_half_ul':
      return <ComputedCell value={inter.plan.diluent_half_ul} dp={2} />
    case 'int_vial_diluent_mg':
      return box('int_vial_diluent_mg')
    case 'stock_vol_ul':
      return <ComputedCell value={inter.plan.stock_vol_ul} dp={2} />
    case 'stock_half_ul':
      return <ComputedCell value={inter.plan.stock_half_ul} dp={2} />
    case 'int_vial_all_mg':
      return box('int_vial_all_mg')
    case 'actual_diluent_ul':
      return (
        <ComputedCell
          value={inter.actual.actual_diluent_ul}
          dp={2}
          mark={inter.off.diluent}
          markTitle={offText('diluent')}
        />
      )
    case 'actual_stock_ul':
      return (
        <ComputedCell
          value={inter.actual.actual_stock_ul}
          dp={2}
          mark={inter.off.stock}
          markTitle={offText('stock')}
        />
      )
    case 'actual_conc_ug_ml':
      return <ComputedCell value={inter.actual.actual_conc_ug_ml} dp={2} />
  }
}
