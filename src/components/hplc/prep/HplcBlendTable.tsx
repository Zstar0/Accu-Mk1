import type { HplcComponentComputed, HplcRowComputed } from '@/lib/hplc-prep'
import type { LeadPick } from '@/lib/hplc-prep-rules'
import { TD } from '@/components/hplc/EndoWorksheetTable'
import type { SheetRowView, SheetSectionProps } from './HplcPrepSheet'
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
  useFailMark,
} from './HplcSheetCells'
import type { HplcSheetRow } from '@/lib/api'
import {
  STEP2B_COLUMNS,
  VIAL_LETTERS,
  type Step2bKey,
} from './hplc-sheet-columns'
import { onSheetKey } from './hplc-sheet-keys'
import { boxKey } from '@/services/hplc-worksheet'

const leadId = (row: HplcSheetRow, peptideId: number) =>
  `hplc-lead-${row.item_id}-${peptideId}`

const COL = Object.fromEntries(STEP2B_COLUMNS.map(c => [c.key, c])) as Record<
  Step2bKey,
  (typeof STEP2B_COLUMNS)[number]
>

/** Why a lead leads when none was chosen, in words. */
const WHY: Record<LeadPick['why'], string> = {
  chosen: 'chosen',
  rule: 'by rule',
  preferred: 'preferred',
  heaviest: 'heaviest',
  first: 'first',
}

/** A weight as the split line shows it: up to 3 dp, trailing zeros dropped. */
const mg = (x: number | null) =>
  x === null ? '-' : String(Number(x.toFixed(3)))

/** The split's own state, shown under the sample id; null when it is whole. */
function splitState(
  computed: HplcRowComputed,
  row: HplcSheetRow
): string | null {
  const comps = computed.components
  if (computed.warnings.some(w => w.code === 'split_mismatch')) {
    const sum = comps.reduce((a, c) => a + (c.declared_mg ?? 0), 0)
    // the row's own declared weight, per capsule on a capsule row, as
    // computeRow compares the split against it
    const declared = row.hplc_prep.declared_mg ?? row.declared_mg
    return `the weights add up to ${mg(sum)}, the vial says ${mg(declared)}`
  }
  const typed = comps.filter(c => c.declared_mg !== null).length
  if (typed === 0) return 'split not typed yet'
  return typed < comps.length ? 'partly typed' : null
}

/** Step 2b: one line per component of each blend row. */
export function HplcBlendTable({ rowViews, onPatch }: SheetSectionProps) {
  const rows = rowViews.filter(v => v.row.is_blend && !v.row.rider_only)
  return (
    <table className="w-full border-collapse" onKeyDown={onSheetKey}>
      <thead>
        <tr>
          {STEP2B_COLUMNS.map(c => (
            <HeadCell key={c.key} col={c} />
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.flatMap(v => {
          const why = [
            v.row.form === null ? 'no HPLC prep for this form' : null,
            ...v.row.problems,
          ].filter(Boolean)
          if (v.computed === null || v.row.problems.length > 0)
            return [
              <SheetRow key={v.row.item_id} shaded={v.shaded}>
                <IdCell>{v.row.sample_id}</IdCell>
                <td
                  className={`${TD} text-muted-foreground`}
                  colSpan={STEP2B_COLUMNS.length - 1}
                >
                  {why.length ? why.join('. ') : 'no HPLC prep for this row'}
                </td>
              </SheetRow>,
            ]
          const computed = v.computed
          return computed.components.map((c, j) => (
            <SheetRow
              key={`${v.row.item_id}-${c.peptide_id}`}
              shaded={v.shaded}
            >
              {STEP2B_COLUMNS.map(col => (
                <BlendCell
                  key={col.key}
                  col={col.key}
                  first={j === 0}
                  view={v}
                  computed={computed}
                  c={c}
                  onPatch={onPatch}
                />
              ))}
            </SheetRow>
          ))
        })}
      </tbody>
    </table>
  )
}

function BlendCell({
  col,
  first,
  view,
  computed,
  c,
  onPatch,
}: {
  col: Step2bKey
  first: boolean
  view: SheetRowView
  computed: HplcRowComputed
  c: HplcComponentComputed
  onPatch: SheetSectionProps['onPatch']
}) {
  const { row, locked } = view
  const id = String(c.peptide_id)
  const facts = row.components.find(x => x.peptide_id === c.peptide_id)
  const name = facts?.name ?? facts?.abbreviation ?? `peptide #${id}`
  const what = `${row.sample_id}, ${COL[col].label}, ${name}`
  const typed = row.hplc_prep.components?.[id] ?? {}
  const n = String(c.vial)
  // a Lead save of this vial that did not land marks its radios
  const leadMark = useFailMark(
    boxKey(row.item_id, `hplc_prep.vials.${n}.lead_id`)
  )
  const letter = VIAL_LETTERS[c.vial - 1] ?? n
  const many = computed.vials.length > 1
  const sendComponent = (key: 'mg' | 'vial' | 'target', v: number | null) =>
    onPatch(
      row.item_id,
      { hplc_prep: { components: { [id]: { [key]: v } } } },
      what
    )
  const keyOf = (key: 'mg' | 'vial' | 'target') =>
    boxKey(row.item_id, `hplc_prep.components.${id}.${key}`)
  const box = (key: 'mg' | 'target', placeholder?: string) => (
    <InputCell>
      <NumberBox
        label={what}
        field={col}
        saveKey={keyOf(key)}
        value={typed[key]}
        placeholder={placeholder}
        disabled={locked}
        // 0 or less means "the standard", as on the source sheet: the key
        // is cleared and the box goes back to its placeholder
        zeroClears
        onCommit={v => sendComponent(key, v)}
      />
    </InputCell>
  )
  switch (col) {
    case 'sample_id': {
      const state = first ? splitState(computed, row) : null
      return (
        <IdCell>
          {first && row.sample_id}
          {state && <Hint>{state}</Hint>}
        </IdCell>
      )
    }
    case 'component':
      return (
        <td className={TD} title="From the Sample Identity in Step 2">
          {name}
        </td>
      )
    case 'mg':
      return box(
        'mg',
        facts?.declared_mg == null ? undefined : String(facts.declared_mg)
      )
    case 'vial': {
      // the catalog's vial; picking it again stores nothing (null)
      const own = facts?.vial ? facts.vial : 1
      const count = Math.max(row.components.length, c.vial, own)
      const letters = VIAL_LETTERS.slice(0, Math.min(count, 7)).split('')
      return (
        <td className={TD}>
          <CellSelect
            label={what}
            field={col}
            saveKey={keyOf('vial')}
            value={letter}
            disabled={locked}
            options={letters.map(L => [L, L])}
            onChange={L => {
              const to = VIAL_LETTERS.indexOf(L) + 1
              sendComponent('vial', to === own ? null : to)
            }}
          />
        </td>
      )
    }
    case 'lead': {
      const vial = computed.vials.find(x => x.vial === c.vial)
      const auto = vial?.lead.why !== 'chosen'
      const usual = `${row.sample_id}, Lead, usual${many ? `, vial ${letter}` : ''}`
      const setLead = (lead: number | null, label: string) =>
        onPatch(
          row.item_id,
          { hplc_prep: { vials: { [n]: { lead_id: lead } } } },
          label
        )
      // the vial's radios sit on separate lines: its first line carries the
      // group, which owns them all
      const ids = vial?.component_ids ?? []
      return (
        <td className={TD}>
          {ids[0] === c.peptide_id && (
            <span
              role="radiogroup"
              aria-label={`${row.sample_id}, Lead for vial ${letter}`}
              aria-owns={ids.map(p => leadId(row, p)).join(' ')}
            />
          )}
          <input
            type="radio"
            id={leadId(row, c.peptide_id)}
            name={`lead-${row.item_id}-${n}`}
            aria-label={what}
            aria-describedby={leadMark.id}
            data-field={col}
            title={COL.lead.title}
            checked={c.lead}
            readOnly
            disabled={locked}
            // the rule's lead shows checked but greyed until one is chosen
            className={`accent-teal-600 ${c.lead && auto ? 'opacity-50' : ''} ${leadMark.outline ? 'rounded-full ring-2 ring-red-500' : ''}`}
            onClick={() => {
              if (!c.lead || auto) setLead(c.peptide_id, what)
            }}
          />
          {leadMark.note}
          {c.lead && auto && vial && <Hint>{WHY[vial.lead.why]}</Hint>}
          {c.lead && !auto && (
            <button
              type="button"
              aria-label={usual}
              title="Back to the usual lead for the blend, else the heaviest"
              disabled={locked}
              onClick={() => setLead(null, usual)}
              className="ml-1.5 text-[11px] text-teal-700 underline-offset-2 hover:underline disabled:opacity-50 dark:text-teal-400"
            >
              usual
            </button>
          )}
        </td>
      )
    }
    case 'stock_conc_ug_ml':
      return <ComputedCell value={c.stock_conc_ug_ml} dp={2} />
    case 'target':
      return box(
        'target',
        c.target.typed ? undefined : fmtDp(c.target.value, 0)
      )
    case 'planned_final_ug_ml':
      return (
        <ComputedCell
          value={c.planned_final_ug_ml}
          dp={2}
          mark={c.below_floor}
          markTitle={`under the ${fmtDp(computed.floor_ug_ml, 0)} ug/mL floor: it can go in its own vial, choose B`}
        />
      )
    case 'actual_final_ug_ml':
      return <ComputedCell value={c.actual_final_ug_ml} dp={2} />
  }
}
