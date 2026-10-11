import type { WorksheetListItem, WorksheetUpdate } from '@/lib/api'
import { fmt } from '@/lib/endo-prep'
import type { EndoCartridgeOption } from '@/lib/endo-worksheet-2ml'
import { Meta } from '@/components/hplc/EndoWorksheetTable'

// Dennis's .meta select: borderless, 13px mono, an accent underline on focus.
const META_SELECT =
  'h-6 w-full min-w-0 cursor-pointer border-0 bg-transparent p-0 font-mono text-[13px] font-medium text-foreground focus:outline-none focus-visible:shadow-[0_1px_0_var(--color-teal-500)] disabled:cursor-default disabled:opacity-70'

/**
 * The run's settings, as cells of Box 1's meta strip where Dennis keeps Prep
 * and Cartridge (spec 2026-10-10 6.1): the prep model, the run cartridge from
 * the allowed list (blank = the method default, which is never written on its
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
        <select
          aria-label="Prep"
          className={META_SELECT}
          value={twoMl ? '2ml' : 'stock'}
          disabled={isCompleted}
          title="2 mL in the vial, then three dilution steps into the cartridge. 1 mg/mL stock is the old prep: switch back only for a run made that way."
          onChange={e =>
            onUpdate({ endo_prep: e.target.value === '2ml' ? '2ml' : 'stock' })
          }
        >
          <option value="2ml">2 mL</option>
          <option value="stock">1 mg/mL stock</option>
        </select>
      </Meta>
      {twoMl && (
        <>
          <Meta
            label="Cartridge"
            title="The run's cartridge; a row can take its own in the table"
          >
            <select
              aria-label="Run cartridge"
              className={META_SELECT}
              value={current ?? ''}
              disabled={isCompleted}
              onChange={e =>
                onUpdate({
                  cartridge_type_id: e.target.value
                    ? Number(e.target.value)
                    : null,
                })
              }
            >
              <option value="">
                {fallback
                  ? `Method default (${fmt(fallback.sensitivity_eu_ml)})`
                  : 'None picked'}
              </option>
              {unlisted && (
                <option value={current ?? ''}>
                  {`${fmt(worksheet.cartridge_sensitivity_eu_ml)} EU/mL (not in the list)`}
                </option>
              )}
              {cartridges.map(c => (
                <option key={c.id} value={c.id} title={c.name}>
                  {`${fmt(c.sensitivity_eu_ml)} EU/mL`}
                </option>
              ))}
            </select>
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
