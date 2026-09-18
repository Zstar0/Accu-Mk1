import { X } from 'lucide-react'
import { useUIStore } from '@/store/ui-store'
import { PriorityGlyph } from '@/components/common/PriorityGlyph'
import { SampleIdBadge } from '@/components/samples/SampleIdBadge'
import { SlaAgeIndicator } from '@/components/hplc/SlaAgeIndicator'
import type { SlaSubjectSnapshot } from '@/services/sla-subjects'
import { legacyEffectivePriority } from '@/lib/inbox-sla'
import type { WorksheetItemPatch, WorksheetListItem } from '@/lib/api'
import { fmt, fmtUl, holidaysBetween, labDate } from '@/lib/endo-prep'
import {
  endoIdentityFor,
  endoItemsInBenchOrder,
  endoPrepFor,
  shortLabDate,
  shortOrder,
  type WorksheetItemRow,
} from '@/lib/endo-worksheet'
import { useLabCalendar } from '@/hooks/use-lab-calendar'
import {
  EndoPrepFields,
  EndoWarning,
  PrepField,
} from '@/components/hplc/EndoPrepLine'
import { PrepStatusSelect } from '@/components/hplc/PrepStatusSelect'
import { ReassignButton } from '@/components/hplc/ReassignButton'

/**
 * Dennis's run table, inside the worksheet flyout: one row per sample in
 * bench order (due date, then priority), with the received and due dates,
 * order, sample id, identity, the weight and volume overrides, and the
 * sample / LAL microlitres to pipette. Rows that will not fit the cartridge
 * or have no diluent are tinted, as on his sheet. The footer carries the
 * run totals the analyst draws reagents against.
 */
interface EndoWorksheetTableProps {
  items: WorksheetItemRow[]
  isCompleted: boolean
  slaByKey: Map<string, SlaSubjectSnapshot>
  slaLoading: boolean
  slaError: boolean
  otherWorksheets: WorksheetListItem[]
  onRemove: (itemId: number) => void
  onReassign: (itemId: number, targetWorksheetId: number) => void
  onUpdateItem: (itemId: number, data: WorksheetItemPatch) => void
}

const TH =
  'px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap'
const TD = 'px-2 py-1.5 align-middle text-xs'
const NUM = `${TD} font-mono tabular-nums text-right`

export function EndoWorksheetTable({
  items,
  isCompleted,
  slaByKey,
  slaLoading,
  slaError,
  otherWorksheets,
  onRemove,
  onReassign,
  onUpdateItem,
}: EndoWorksheetTableProps) {
  const { calendar } = useLabCalendar()
  const dueAtByItemId = new Map(
    items.map(it => [it.id, slaByKey.get(String(it.id))?.status.due_at ?? null])
  )
  const ordered = endoItemsInBenchOrder(items, dueAtByItemId, calendar)

  let sumSample = 0
  let sumLal = 0
  let nWater = 0
  const rows = ordered.map(item => {
    const prep = endoPrepFor(item)
    sumSample += prep.sampleUl ?? 0
    sumLal += prep.lalUl ?? 0
    if (prep.isWater) nWater++
    const received = calendar ? labDate(item.date_received, calendar) : null
    const due = calendar ? labDate(dueAtByItemId.get(item.id), calendar) : null
    const skipped = calendar ? holidaysBetween(received, due, calendar) : []
    return { item, prep, received, due, skipped }
  })

  return (
    <div className="overflow-x-auto pb-4">
      <table className="w-full border-separate border-spacing-0">
        <thead>
          <tr className="border-b">
            <th className={`${TH} w-8 text-right`}>#</th>
            <th className={TH}>Received</th>
            <th className={TH}>Due</th>
            <th className={TH}>Priority</th>
            <th className={TH}>Order #</th>
            <th className={TH}>Sample ID</th>
            <th className={TH}>Sample identity</th>
            <th className={`${TH} text-right`}>
              Wt <span className="normal-case tracking-normal">mg</span>
            </th>
            <th className={`${TH} text-right`}>
              Volume <span className="normal-case tracking-normal">mL</span>
            </th>
            <th className={`${TH} text-right`}>
              Sample <span className="normal-case tracking-normal">µL</span>
            </th>
            <th className={`${TH} text-right`}>
              LAL <span className="normal-case tracking-normal">µL</span>
            </th>
            <th className={`${TH} text-right`}>
              Vial <span className="normal-case tracking-normal">mg/mL</span>
            </th>
            <th className={TH}>SLA</th>
            <th className={TH}>Status</th>
            <th className={`${TH} text-right`} />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ item, prep, received, due, skipped }, i) => (
            <tr
              key={item.id}
              className={`group/item border-b border-border/40 hover:bg-muted/50 ${
                prep.warning === 'over_cartridge'
                  ? 'bg-red-500/5'
                  : prep.warning === 'no_diluent'
                    ? 'bg-amber-500/5'
                    : i % 2
                      ? 'bg-muted/20'
                      : ''
              }`}
            >
              <td className={`${NUM} text-muted-foreground/60`}>{i + 1}</td>
              <td className={`${TD} font-mono tabular-nums whitespace-nowrap`}>
                {shortLabDate(received)}
              </td>
              <td
                className={`${TD} font-mono tabular-nums font-semibold whitespace-nowrap`}
                title={
                  skipped.length
                    ? `Pushed past ${skipped.map(h => h.name).join(', ')}`
                    : due
                      ? 'From the SLA engine: the business clock reaches the target'
                      : undefined
                }
              >
                {shortLabDate(due)}
                {skipped.length > 0 && <sup className="text-primary">*</sup>}
              </td>
              <td className={TD}>
                <PriorityGlyph
                  priority={legacyEffectivePriority(item.priority)}
                  size="row"
                />
              </td>
              <td className={`${TD} font-mono tabular-nums`}>
                {shortOrder(item.client_order_number) || '—'}
              </td>
              <td className={TD}>
                <button
                  className="text-left hover:underline hover:text-primary transition-colors"
                  onClick={() =>
                    useUIStore.getState().navigateToSample(item.sample_id)
                  }
                >
                  <SampleIdBadge
                    id={item.sample_id}
                    variance={item.assignment_kind === 'variance'}
                  />
                </button>
              </td>
              <td className={`${TD} max-w-[220px]`}>
                <span className="block truncate" title={endoIdentityFor(item)}>
                  {endoIdentityFor(item) || '—'}
                </span>
              </td>
              {prep.isWater ? (
                <td className={`${TD} text-right`} colSpan={2}>
                  <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                    <EndoPrepFields
                      item={item}
                      prep={prep}
                      isCompleted={isCompleted}
                      onUpdate={data => onUpdateItem(item.id, data)}
                    />
                    dilution
                  </span>
                </td>
              ) : (
                <EndoOverrideCells
                  item={item}
                  prep={prep}
                  isCompleted={isCompleted}
                  onUpdate={data => onUpdateItem(item.id, data)}
                />
              )}
              <td className={`${NUM} font-semibold text-foreground`}>
                {fmtUl(prep.sampleUl) || '—'}
              </td>
              <td className={`${NUM} font-semibold text-foreground`}>
                {fmtUl(prep.lalUl) || '—'}
              </td>
              <td className={NUM}>
                {prep.isWater ? (
                  <span className="text-muted-foreground">n/a</span>
                ) : (
                  fmt(prep.vialConc) || '—'
                )}
              </td>
              <td className={TD}>
                <SlaAgeIndicator
                  snapshot={slaByKey.get(String(item.id)) ?? null}
                  isLoading={slaLoading}
                  isError={slaError}
                  compact
                />
              </td>
              <td className={TD}>
                <PrepStatusSelect
                  status={item.prep_status}
                  isCompleted={isCompleted}
                  onChange={value =>
                    onUpdateItem(item.id, { prep_status: value })
                  }
                />
              </td>
              <td className={`${TD} text-right whitespace-nowrap`}>
                <span className="inline-flex items-center gap-1">
                  <EndoWarning warning={prep.warning} />
                  {!isCompleted && (
                    <ReassignButton
                      item={item}
                      otherWorksheets={otherWorksheets}
                      onReassign={onReassign}
                    />
                  )}
                  {!isCompleted && (
                    <button
                      className="h-6 w-6 inline-flex items-center justify-center opacity-0 group-hover/item:opacity-100 transition-opacity text-muted-foreground hover:text-destructive rounded"
                      aria-label={`Remove ${item.sample_id} from worksheet`}
                      onClick={() => onRemove(item.id)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t text-[11px] text-muted-foreground">
            <td className={TD} colSpan={9}>
              <span className="font-semibold text-foreground">
                {rows.length}
              </span>{' '}
              samples
              {nWater > 0 && (
                <> · {nWater} bacteriostatic water, prepped as a dilution</>
              )}
            </td>
            <td className={`${NUM} font-semibold text-foreground`}>
              {fmtUl(sumSample)}
            </td>
            <td className={`${NUM} font-semibold text-foreground`}>
              {fmtUl(sumLal)}
            </td>
            <td className={TD} colSpan={4}>
              µL to draw
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function EndoOverrideCells({
  item,
  prep,
  isCompleted,
  onUpdate,
}: {
  item: WorksheetItemRow
  prep: ReturnType<typeof endoPrepFor>
  isCompleted: boolean
  onUpdate: (data: WorksheetItemPatch) => void
}) {
  return (
    <>
      <td className={`${NUM} text-right`}>
        <PrepFieldCell
          label="Weight"
          unit="mg"
          value={prep.weightMg}
          overridden={prep.weightOverridden}
          computed={item.declared_weight_mg ?? null}
          disabled={isCompleted}
          onCommit={v => onUpdate({ prep_weight_mg: v })}
        />
      </td>
      <td className={`${NUM} text-right`}>
        <PrepFieldCell
          label="Volume"
          unit="mL"
          value={prep.volumeMl}
          overridden={prep.volumeOverridden}
          computed={prep.autoVolumeMl}
          disabled={isCompleted}
          onCommit={v => onUpdate({ prep_volume_ml: v })}
        />
      </td>
    </>
  )
}

function PrepFieldCell(props: Parameters<typeof PrepField>[0]) {
  return <PrepField {...props} bare />
}

export default EndoWorksheetTable
