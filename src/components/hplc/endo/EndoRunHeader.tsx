import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { WorksheetListItem, WorksheetUpdate } from '@/lib/api'
import { fmt } from '@/lib/endo-prep'
import type { EndoCartridgeOption } from '@/lib/endo-worksheet-2ml'
import { Meta } from '@/components/hplc/EndoWorksheetTable'

// The Analyst picker's trigger (EndoWorksheetView), whose meta strip these
// share; disabled as before.
const META_TRIGGER =
  'h-6 w-full border-0 bg-transparent p-0 text-sm font-medium shadow-none focus:ring-0 disabled:cursor-default disabled:opacity-70'
// Radix Select holds no empty value: the method default rides on this.
const INHERIT = '__inherit__'

/**
 * The run's settings, as cells of Box 1's meta strip where Dennis keeps Prep
 * and Cartridge (spec 2026-10-10 6.1): the prep model, the run cartridge from
 * the allowed list (no pick = the method default, which is never written on its
 * own) and the method revision the numbers come from. Each change is one
 * worksheet PUT. The title, analyst, dates, orders and Preview / Print / CSV
 * stay where they are on every endo worksheet: EndoWorksheetView's top bar
 * and the meta strip's first cells.
 */
export function EndoRunHeader({
  worksheet,
  cartridges,
  isCompleted,
  onUpdate,
}: {
  worksheet: WorksheetListItem
  /** The allowed cartridges (allowedCartridges). */
  cartridges: EndoCartridgeOption[]
  isCompleted: boolean
  onUpdate: (data: WorksheetUpdate) => void
}) {
  const twoMl = worksheet.endo_prep === '2ml'
  const method = worksheet.endo_method ?? null
  const current = worksheet.cartridge_type_id ?? null
  const fallback = cartridges.find(c => c.is_default) ?? null
  // A retired or no-longer-allowed run cartridge stays visible, never offered.
  const unlisted = current != null && !cartridges.some(c => c.id === current)
  return (
    <>
      <Meta label="Prep">
        <Select
          value={twoMl ? '2ml' : 'stock'}
          disabled={isCompleted}
          onValueChange={v =>
            onUpdate({ endo_prep: v === '2ml' ? '2ml' : 'stock' })
          }
        >
          <SelectTrigger
            aria-label="Prep"
            title="2 mL in the vial, then three dilution steps into the cartridge. 1 mg/mL stock is the old prep: switch back only for a run made that way."
            className={META_TRIGGER}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="2ml">2 mL</SelectItem>
            <SelectItem value="stock">1 mg/mL stock</SelectItem>
          </SelectContent>
        </Select>
      </Meta>
      {twoMl && (
        <>
          <Meta
            label="Cartridge"
            title="The run's cartridge; a row can take its own in the table"
          >
            <Select
              value={current == null ? INHERIT : String(current)}
              disabled={isCompleted}
              onValueChange={v =>
                onUpdate({
                  cartridge_type_id: v === INHERIT ? null : Number(v),
                })
              }
            >
              <SelectTrigger
                aria-label="Run cartridge"
                className={META_TRIGGER}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>
                  {fallback
                    ? `Method default (${fmt(fallback.sensitivity_eu_ml)})`
                    : 'None picked'}
                </SelectItem>
                {unlisted && (
                  <SelectItem value={String(current)}>
                    {`${fmt(worksheet.cartridge_sensitivity_eu_ml)} EU/mL (not in the list)`}
                  </SelectItem>
                )}
                {cartridges.map(c => (
                  <SelectItem key={c.id} value={String(c.id)} title={c.name}>
                    {`${fmt(c.sensitivity_eu_ml)} EU/mL`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Meta>
          <Meta
            label="Method"
            title={
              method
                ? worksheet.endo_method_id
                  ? 'Pinned at the first print or reading: later revisions do not change this run'
                  : 'The active method; it is pinned at the first print or reading'
                : "No single method resolves: Dennis's standard values apply"
            }
          >
            <span className="block truncate text-sm font-medium">
              {method
                ? `${method.name} rev ${method.revision}`
                : 'Standard values'}
            </span>
          </Meta>
        </>
      )}
    </>
  )
}

export default EndoRunHeader
