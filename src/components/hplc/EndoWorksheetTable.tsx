import type { ReactNode } from 'react'
import { Check, Flag, X } from 'lucide-react'
import { useUIStore } from '@/store/ui-store'
import { SampleIdBadge } from '@/components/samples/SampleIdBadge'
import { SlaAgeIndicator } from '@/components/hplc/SlaAgeIndicator'
import type { SlaSubjectSnapshot } from '@/services/sla-subjects'
import type {
  WorksheetItemPatch,
  WorksheetListItem,
  WorksheetUser,
} from '@/lib/api'
import { fmt, fmtUl, holidaysBetween, labDate } from '@/lib/endo-prep'
import {
  endoIdentityFor,
  endoItemsInBenchOrder,
  endoPrepFor,
  shortLabDate,
  shortOrder,
  type WorksheetItemRow,
} from '@/lib/endo-worksheet'
import { displayName } from '@/lib/user-display'
import { useLabCalendar } from '@/hooks/use-lab-calendar'
import { useEntityFlags } from '@/hooks/use-flags'
import { flagTypeDef } from '@/components/flags/flag-catalog'
import { useFlagTypesMap } from '@/services/flag-types'
import { RaiseFlagButton } from '@/components/flags/RaiseFlagButton'
import { PrepField } from '@/components/hplc/EndoPrepLine'
import { ReassignButton } from '@/components/hplc/ReassignButton'

/**
 * Dennis's run sheet, in the worksheet flyout: a meta strip (analyst, date
 * made, due, orders), one row per sample in bench order (due date, then
 * priority), the three figures the analyst may type (target, declared
 * weight, volume to add) on the plain surface and the three worked out from
 * them (sample, LAL, vial concentration) on the tinted one, then the Made and
 * MCS ticks and a flag. Rows that will not fit the cartridge or have no
 * diluent carry a red / amber edge, as on his sheet.
 */
interface EndoWorksheetTableProps {
  items: WorksheetItemRow[]
  isCompleted: boolean
  /** The analyst cell of the meta strip (a select while the worksheet is open). */
  analyst: ReactNode
  createdAt: string | null
  users: WorksheetUser[]
  slaByKey: Map<string, SlaSubjectSnapshot>
  slaLoading: boolean
  slaError: boolean
  otherWorksheets: WorksheetListItem[]
  onRemove: (itemId: number) => void
  onReassign: (itemId: number, targetWorksheetId: number) => void
  onUpdateItem: (itemId: number, data: WorksheetItemPatch) => void
  /** Tick a whole column: the sheet is worked on paper and keyed in after. */
  onTickAll: (data: { made?: boolean; ran?: boolean }) => void
}

const TH =
  'sticky top-0 z-[2] bg-muted/60 px-2 pb-[7px] pt-2 text-left align-bottom text-[9.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground whitespace-nowrap border-b'
const TH_CALC = 'bg-teal-500/10 text-teal-800 dark:text-teal-200 text-right'
const UNIT =
  'block font-mono text-[10px] font-normal normal-case tracking-[0.04em] opacity-80'
const TD = 'border-b border-border/60 px-2 py-[5px] align-middle text-[13px]'
const MONO = 'font-mono text-[12.5px] tabular-nums'
const TD_CALC = `${TD} ${MONO} bg-teal-500/[0.06] text-right text-foreground/80 whitespace-nowrap group-hover/item:bg-teal-500/10`

const PRIORITY_CHIP: Record<string, string> = {
  expedited: 'border-red-500/40 bg-red-500/10 text-red-600 font-semibold',
  high: 'border-amber-500/40 bg-amber-500/10 text-amber-600 font-semibold',
  normal: 'border-border text-muted-foreground',
}
const PRIORITY_LABEL: Record<string, string> = {
  expedited: 'Expedited',
  high: 'High',
  normal: 'Default',
}

export function EndoWorksheetTable({
  items,
  isCompleted,
  analyst,
  createdAt,
  users,
  slaByKey,
  slaLoading,
  slaError,
  otherWorksheets,
  onRemove,
  onReassign,
  onUpdateItem,
  onTickAll,
}: EndoWorksheetTableProps) {
  const { calendar } = useLabCalendar()
  const dueAtByItemId = new Map(
    items.map(it => [it.id, slaByKey.get(String(it.id))?.status.due_at ?? null])
  )
  const ordered = endoItemsInBenchOrder(items, dueAtByItemId, calendar)

  const rows = ordered.map(item => {
    const prep = endoPrepFor(item)
    const received = calendar ? labDate(item.date_received, calendar) : null
    const due = calendar ? labDate(dueAtByItemId.get(item.id), calendar) : null
    const skipped = calendar ? holidaysBetween(received, due, calendar) : []
    return { item, prep, received, due, skipped }
  })
  const sumSample = rows.reduce((s, r) => s + (r.prep.sampleUl ?? 0), 0)
  const sumLal = rows.reduce((s, r) => s + (r.prep.lalUl ?? 0), 0)
  const nMade = rows.filter(r => r.item.made_at).length
  const nRan = rows.filter(r => r.item.ran_at).length
  const runDue = rows
    .map(r => r.due)
    .filter((d): d is string => !!d)
    .sort()[0]
  const orders = [
    ...new Set(
      rows.map(r => shortOrder(r.item.client_order_number)).filter(Boolean)
    ),
  ].join(', ')

  return (
    <div className="overflow-hidden rounded-[5px] border bg-card shadow-sm">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] border-b">
        <Meta label="Analyst">{analyst}</Meta>
        <Meta label="Date made">
          <span className={MONO}>
            {shortLabDate(calendar ? labDate(createdAt, calendar) : null)}
          </span>
        </Meta>
        <Meta label="Due date" title="The earliest due date on this run">
          <span className={MONO}>{shortLabDate(runDue ?? null)}</span>
        </Meta>
        <Meta label="Orders">
          <span className={`${MONO} block truncate`} title={orders}>
            {orders || '-'}
          </span>
        </Meta>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] border-collapse">
          <thead>
            <tr>
              <th className={`${TH} w-[34px]`} />
              <th className={TH}>Received</th>
              <th className={`${TH} ${TH_CALC} !text-left`}>
                Due<span className={UNIT}>SLA</span>
              </th>
              <th className={TH}>Priority</th>
              <th className={TH}>Order #</th>
              <th className={TH}>Sample ID</th>
              <th className={TH}>Sample identity</th>
              <th className={`${TH} text-right`}>
                Target<span className={UNIT}>mg/mL</span>
              </th>
              <th className={`${TH} text-right`}>
                Declared wt<span className={UNIT}>mg</span>
              </th>
              <th className={`${TH} text-right`}>
                Volume to add<span className={UNIT}>mL</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                Sample needed<span className={UNIT}>µL</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                LAL needed<span className={UNIT}>µL</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                Vial conc.<span className={UNIT}>mg/mL</span>
              </th>
              <th className={`${TH} text-center`}>
                <TickAll
                  label="Made"
                  left={rows.length - nMade}
                  disabled={isCompleted}
                  onClick={() => onTickAll({ made: true })}
                />
              </th>
              <th className={`${TH} text-center`}>
                <TickAll
                  label="MCS"
                  left={rows.length - nRan}
                  disabled={isCompleted}
                  onClick={() => onTickAll({ ran: true })}
                />
              </th>
              <th className={`${TH} text-center`}>Flag</th>
              <th className={TH} />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, prep, received, due, skipped }, i) => {
              const priority = (item.priority ?? 'normal').toLowerCase()
              const edge =
                prep.warning === 'over_cartridge'
                  ? 'before:bg-red-500'
                  : prep.warning === 'no_diluent'
                    ? 'before:bg-amber-500'
                    : 'before:bg-transparent'
              return (
                <tr
                  key={item.id}
                  className="group/item hover:bg-teal-500/[0.04]"
                >
                  <td
                    className={`${TD} relative pl-3 pr-1.5 text-right font-mono text-[11px] text-muted-foreground before:absolute before:inset-y-0 before:left-0 before:w-[3px] ${edge}`}
                    title={
                      prep.warning === 'over_cartridge'
                        ? 'The sample will not fit the 1000 µL cartridge'
                        : prep.warning === 'no_diluent'
                          ? 'No room left for LAL diluent'
                          : undefined
                    }
                  >
                    {i + 1}
                  </td>
                  <td className={`${TD} ${MONO} whitespace-nowrap`}>
                    {shortLabDate(received)}
                  </td>
                  <td
                    className={`${TD_CALC} !text-left font-medium !text-foreground`}
                    title={
                      skipped.length
                        ? `Pushed past ${skipped.map(h => h.name).join(', ')}`
                        : undefined
                    }
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <span>
                        {shortLabDate(due)}
                        {skipped.length > 0 && (
                          <sup className="ml-px font-bold text-teal-600">*</sup>
                        )}
                      </span>
                      <SlaAgeIndicator
                        snapshot={slaByKey.get(String(item.id)) ?? null}
                        isLoading={slaLoading}
                        isError={slaError}
                        compact
                      />
                    </span>
                  </td>
                  <td className={TD}>
                    <span
                      className={`inline-block rounded-[3px] border px-1.5 py-0.5 text-xs ${PRIORITY_CHIP[priority] ?? PRIORITY_CHIP.normal}`}
                    >
                      {PRIORITY_LABEL[priority] ?? priority}
                    </span>
                  </td>
                  <td className={`${TD} ${MONO}`}>
                    {shortOrder(item.client_order_number) || '-'}
                  </td>
                  <td className={TD}>
                    <button
                      className="text-left transition-colors hover:text-primary hover:underline"
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
                  <td className={`${TD} max-w-[200px]`}>
                    <span
                      className="block truncate"
                      title={endoIdentityFor(item)}
                    >
                      {endoIdentityFor(item) || '-'}
                    </span>
                  </td>
                  {prep.isWater ? (
                    <>
                      <td
                        className={`${TD} text-right text-muted-foreground`}
                      />
                      <td
                        className={`${TD} text-right text-muted-foreground`}
                      />
                      <td className={`${TD} w-[92px] px-1`}>
                        <PrepField
                          bare
                          label="Dilution factor"
                          unit="×"
                          value={prep.dilution}
                          overridden={item.prep_dilution_factor != null}
                          computed={20}
                          disabled={isCompleted}
                          onCommit={v =>
                            onUpdateItem(item.id, { prep_dilution_factor: v })
                          }
                        />
                      </td>
                    </>
                  ) : (
                    <>
                      <td className={`${TD} w-[72px] px-1 text-right`}>
                        <PrepField
                          bare
                          label="Target concentration"
                          unit="mg/mL"
                          value={prep.targetMgPerMl}
                          overridden={prep.targetOverridden}
                          computed={1}
                          disabled={isCompleted}
                          onCommit={v =>
                            onUpdateItem(item.id, { prep_target_mg_ml: v })
                          }
                        />
                      </td>
                      <td className={`${TD} w-[92px] px-1 text-right`}>
                        <PrepField
                          bare
                          label="Declared weight"
                          unit="mg"
                          value={prep.weightMg}
                          overridden={prep.weightOverridden}
                          computed={item.declared_weight_mg ?? null}
                          disabled={isCompleted}
                          onCommit={v =>
                            onUpdateItem(item.id, { prep_weight_mg: v })
                          }
                        />
                      </td>
                      <td className={`${TD} w-[92px] px-1 text-right`}>
                        <PrepField
                          bare
                          label="Volume to add"
                          unit="mL"
                          value={prep.volumeMl}
                          overridden={prep.volumeOverridden}
                          computed={prep.autoVolumeMl}
                          disabled={isCompleted}
                          onCommit={v =>
                            onUpdateItem(item.id, { prep_volume_ml: v })
                          }
                        />
                      </td>
                    </>
                  )}
                  <td className={TD_CALC}>{fmtUl(prep.sampleUl)}</td>
                  <td className={TD_CALC}>{fmtUl(prep.lalUl)}</td>
                  <td className={TD_CALC}>
                    {prep.isWater ? (
                      <span
                        className="inline-block rounded-[3px] bg-amber-500/15 px-1.5 py-px font-mono text-[10px] font-medium text-amber-700 dark:text-amber-300"
                        title={`Bacteriostatic water: ${fmtUl(prep.sampleUl)} µL of sample made up to 1000 µL with LAL water`}
                      >
                        {fmt(prep.dilution)}× dilution
                      </span>
                    ) : (
                      fmt(prep.vialConc)
                    )}
                  </td>
                  <td className={`${TD} text-center`}>
                    <Tick
                      label="Made"
                      at={item.made_at}
                      byUserId={item.made_by_user_id}
                      users={users}
                      disabled={isCompleted}
                      onToggle={on => onUpdateItem(item.id, { made: on })}
                    />
                  </td>
                  <td className={`${TD} text-center`}>
                    <Tick
                      label="Ran on the MCS"
                      at={item.ran_at}
                      byUserId={item.ran_by_user_id}
                      users={users}
                      disabled={isCompleted}
                      onToggle={on => onUpdateItem(item.id, { ran: on })}
                    />
                  </td>
                  <td className={`${TD} text-center`}>
                    <FlagCell item={item} />
                  </td>
                  <td className={`${TD} whitespace-nowrap text-right`}>
                    {!isCompleted && (
                      <span className="inline-flex items-center gap-1">
                        <ReassignButton
                          item={item}
                          otherWorksheets={otherWorksheets}
                          onReassign={onReassign}
                        />
                        <button
                          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/item:opacity-100 focus-visible:opacity-100"
                          aria-label={`Remove ${item.sample_id} from worksheet`}
                          title="Remove this sample (it goes back to the inbox)"
                          onClick={() => onRemove(item.id)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t bg-muted/60 px-3.5 py-2.5">
        <Total label="Samples" value={String(rows.length)} />
        <Total label="Sample volume" value={fmtUl(sumSample)} unit="µL" />
        <Total label="LAL volume" value={fmtUl(sumLal)} unit="µL" />
        <span className="flex-1" />
        <Total label="Made" value={`${nMade}/${rows.length}`} />
        <Total label="MCS" value={`${nRan}/${rows.length}`} />
      </div>
    </div>
  )
}

/** The formulas behind the sheet, as Dennis prints them under his table. */
export function EndoCalculations() {
  const cells: [string, string][] = [
    [
      'Due date',
      '= the SLA clock: received + the turnaround in business time, skipping lab holidays',
    ],
    ['Volume to add', '= MIN(10, 1 + FLOOR(wt ÷ 50))'],
    ['Vial concentration', '= declared wt ÷ volume to add'],
    ['Sample needed', '= target ÷ vial conc. × 1000'],
    ['LAL needed', '= 1000 − sample needed'],
    ['Bacteriostatic water', '20× dilution: 50 µL made to 1000 µL with LAL'],
  ]
  return (
    <section>
      <h3 className="pb-2 text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
        Calculations
      </h3>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] overflow-hidden rounded-[5px] border">
        {cells.map(([term, formula]) => (
          <div
            key={term}
            className="border-r bg-card px-3.5 py-2.5 last:border-r-0"
          >
            <dt className="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {term}
            </dt>
            <dd className="font-mono text-xs text-foreground/80">{formula}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function Meta({
  label,
  title,
  children,
}: {
  label: string
  title?: string
  children: ReactNode
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 border-r px-3.5 py-2.5 last:border-r-0"
      title={title}
    >
      <span className="text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  )
}

function Total({
  label,
  value,
  unit,
}: {
  label: string
  value: string
  unit?: string
}) {
  return (
    <span className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
      {label}
      <b className="font-mono text-[13px] font-medium tabular-nums text-foreground">
        {value || '0'}
      </b>
      {unit}
    </span>
  )
}

/**
 * A tick column's heading, which also ticks every row still open. It only
 * ever sets ticks: a slip cannot wipe a run's stamps (untick a row by hand).
 */
function TickAll({
  label,
  left,
  disabled,
  onClick,
}: {
  label: string
  left: number
  disabled: boolean
  onClick: () => void
}) {
  if (disabled || left === 0) return <>{label}</>
  return (
    <button
      type="button"
      className="rounded-[3px] px-1 uppercase tracking-[0.09em] underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-teal-500"
      title={`Tick ${label} on the ${left} row${left === 1 ? '' : 's'} still open`}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

/** A bench tick. The server stamps who and when; the tooltip shows both. */
function Tick({
  label,
  at,
  byUserId,
  users,
  disabled,
  onToggle,
}: {
  label: string
  at?: string | null
  byUserId?: number | null
  users: WorksheetUser[]
  disabled: boolean
  onToggle: (on: boolean) => void
}) {
  const on = !!at
  const by = users.find(u => u.id === byUserId)
  const when = at
    ? new Date(at).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : ''
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      disabled={disabled}
      title={
        on
          ? `${label}${by ? ` by ${displayName(by)}` : ''} · ${when}`
          : `Mark: ${label.toLowerCase()}`
      }
      onClick={() => onToggle(!on)}
      className={`inline-flex h-[22px] w-[22px] items-center justify-center rounded border transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-teal-500 disabled:cursor-default ${
        on
          ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
          : 'border-border bg-card text-transparent enabled:hover:border-teal-500'
      }`}
    >
      <Check className="h-3.5 w-3.5" strokeWidth={3} />
    </button>
  )
}

const OPEN_FLAG_STATES = new Set(['open', 'in_progress', 'blocked'])

/**
 * Dennis's Flag tick, as a real Mk1 flag on the vial (or the parent sample
 * for a legacy item): no open flag opens the raise-flag compose, an open one
 * shows in its type colour and opens the thread.
 */
function FlagCell({ item }: { item: WorksheetItemRow }) {
  const entityType = item.lims_sub_sample_pk ? 'sub_sample' : 'sample'
  const entityId = item.lims_sub_sample_pk
    ? String(item.lims_sub_sample_pk)
    : item.sample_id
  const { data } = useEntityFlags(entityType, entityId)
  const typesMap = useFlagTypesMap()
  const open = (data ?? []).filter(f => OPEN_FLAG_STATES.has(f.status))
  const box =
    'inline-flex h-[22px] w-[22px] items-center justify-center rounded border'

  const [first] = open
  if (!first) {
    return (
      <RaiseFlagButton
        entityType={entityType}
        entityId={entityId}
        targetLabel={item.sample_id}
        trigger={
          <button
            type="button"
            aria-label={`Raise a flag on ${item.sample_id}`}
            title="Raise a flag"
            className={`${box} border-border bg-card text-muted-foreground/40 hover:border-teal-500 hover:text-foreground`}
          >
            <Flag className="h-3 w-3" />
          </button>
        }
      />
    )
  }
  const def = typesMap[first.type] ?? flagTypeDef(first.type)
  return (
    <button
      type="button"
      aria-label={`${open.length} open flag${open.length === 1 ? '' : 's'} on ${item.sample_id}`}
      title={`${def.label}${open.length > 1 ? ` (+${open.length - 1} more)` : ''}: open it`}
      className={`${box} border-transparent text-white`}
      style={{ backgroundColor: def.color }}
      onClick={() =>
        open.length === 1
          ? useUIStore.getState().openFlagThread(first.id)
          : useUIStore.getState().openFlagsForEntity(entityType, entityId, {
              includeDescendants: false,
            })
      }
    >
      <Flag className="h-3 w-3" fill="currentColor" />
    </button>
  )
}

export default EndoWorksheetTable
