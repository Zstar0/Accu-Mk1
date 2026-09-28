import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown, X } from 'lucide-react'
import { useUIStore } from '@/store/ui-store'
import { SampleIdBadge } from '@/components/samples/SampleIdBadge'
import { SlaAgeIndicator } from '@/components/hplc/SlaAgeIndicator'
import {
  FlagCell,
  PriorityChip,
  Tick,
} from '@/components/hplc/EndoWorksheetTable'
import type { WorksheetItemPatch, WorksheetUser } from '@/lib/api'
import type { SlaSubjectSnapshot } from '@/services/sla-subjects'
import { labTime, type LabCalendar } from '@/lib/endo-prep'
import { shortLabDate, type WorksheetItemRow } from '@/lib/endo-worksheet'
import {
  nextSort,
  orderGroups,
  wellsOf,
  type PcrSort,
  type PcrSortKey,
} from '@/lib/pcr-plate'
import type { PcrRunDoc } from '@/lib/pcr-worksheet'

const TH =
  'sticky top-0 z-[2] bg-muted/60 px-2 pb-[7px] pt-2 text-left align-bottom text-[9.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground whitespace-nowrap border-b'
const TD = 'border-b border-border/60 px-2 py-[5px] align-middle text-[13px]'
const MONO = 'font-mono text-[12.5px] tabular-nums'
const SUBTIME =
  'block text-[10px] font-normal leading-tight text-muted-foreground'

/**
 * Dennis's Samples panel: the run list in well order (order chips above it),
 * one row per sample with its order, id, its own Made and Ran ticks, identity,
 * received and due dates, priority, the wells it sits in on the plate, a
 * flag, and Remove. The NPC closes the list as a control row. Rows of one
 * order share a tint with their block on the plate.
 *
 * The per-row ticks are the endo table's (Handler, 2026-09-23): the run-level
 * boxes only ever set, so a single row is where a slip is undone. They sit
 * right after the id, not at the far right as on endo, so they stay in view
 * when a narrow window scrolls the table sideways past the identity.
 *
 * The columns sort (Handler, 2026-09-24) and the plate is dealt in the list's
 * order, so the list and the plate never disagree. The sort is saved on the
 * worksheet, shared by everyone; '#' returns to worksheet order. Locked wells
 * never move, so after a print a sort only re-deals the unlocked samples.
 *
 * No Reassign here (ruling 2026-09-23): a sample that has to leave a run goes
 * back to the inbox and joins the next run like a new arrival, as Dennis's
 * lab carried unrun samples into the next day's CSV.
 */
export function PcrSampleList({
  doc,
  items,
  users,
  calendar,
  slaByKey,
  slaLoading,
  slaError,
  isCompleted,
  sort,
  onSort,
  onRemove,
  onUpdateItem,
}: {
  doc: PcrRunDoc
  items: WorksheetItemRow[]
  /** For the ticks' "by whom" tooltip. */
  users: WorksheetUser[]
  calendar: LabCalendar | null
  slaByKey: Map<string, SlaSubjectSnapshot>
  slaLoading: boolean
  slaError: boolean
  isCompleted: boolean
  sort: PcrSort
  /** Absent on a completed worksheet: the headers are then plain labels. */
  onSort?: (next: PcrSort) => void
  onRemove: (itemId: number) => void
  onUpdateItem: (itemId: number, data: WorksheetItemPatch) => void
}) {
  const L = doc.layout
  const byId = new Map(items.map(it => [it.id, it]))
  const groups = doc.sortByOrder
    ? orderGroups(L.plates).filter(g => g.order || g.isControl)
    : []

  return (
    <section className="overflow-hidden rounded-[5px] border bg-card shadow-sm">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b bg-muted/60 px-3.5 py-2">
        <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
          Samples
        </h3>
        <span className="text-xs text-muted-foreground">
          {doc.summary.samples} sample{doc.summary.samples === 1 ? '' : 's'}
          {L.plateCount > 1 &&
            ` on ${L.plateCount} plates (${L.plates.map(pl => pl.sampleCount).join(' + ')}); the NPC sits on every plate`}
        </span>
        {onSort && L.frozenCount > 0 && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            Locked wells stay put; a sort moves only the unlocked samples.
          </span>
        )}
      </header>
      {groups.length >= 2 && (
        <div className="flex flex-wrap gap-1 border-b px-3.5 py-2">
          {groups.map(g => {
            const span = g.from === g.to ? g.from : `${g.from}-${g.to}`
            return (
              <span
                key={`${g.plate}-${g.group}`}
                className={`inline-flex items-baseline gap-1 rounded-[3px] border border-[#44546a]/60 px-1.5 py-0.5 text-[11px] text-zinc-900 dark:border-[#9fb3cf]/50 dark:text-zinc-100 ${
                  g.isControl
                    ? 'bg-[#d9d9d9] dark:bg-zinc-600'
                    : g.group % 2 === 1
                      ? 'bg-[#bdd7ee] dark:bg-[#2b5582]'
                      : 'bg-[#deeaf6] dark:bg-[#1d3a5c]'
                }`}
                title={`${g.isControl ? 'Controls' : `Order ${g.order}`}${L.plateCount > 1 ? ` · plate ${g.plate}` : ''} · wells ${span}${g.flagged ? ` · ${g.flagged} priority` : ''}`}
              >
                {L.plateCount > 1 && (
                  <b className="bg-[#44546a] px-1 text-[9px] text-white">
                    P{g.plate}
                  </b>
                )}
                <b className="font-mono">
                  {g.isControl ? 'Controls' : g.order}
                </b>
                <span className="font-mono">{span}</span>
                <span className="text-zinc-600 dark:text-zinc-300">
                  ×{g.count}
                </span>
                {g.flagged > 0 && (
                  <span className="rounded-[2px] bg-[#c00000] px-1 text-[10px] font-bold text-white">
                    !{g.flagged > 1 ? g.flagged : ''}
                  </span>
                )}
              </span>
            )
          })}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <SortTh
                className={`${TH} w-[34px]`}
                label="#"
                sortKey="listed"
                sort={sort}
                onSort={onSort}
              />
              <SortTh
                label="Order #"
                sortKey="order"
                sort={sort}
                onSort={onSort}
              />
              <SortTh
                label="Sample ID"
                sortKey="sampleId"
                sort={sort}
                onSort={onSort}
              />
              <th className={`${TH} text-center`}>Made</th>
              <th className={`${TH} text-center`}>Ran</th>
              <SortTh
                label="Sample identity"
                sortKey="identity"
                sort={sort}
                onSort={onSort}
              />
              <SortTh
                label="Received"
                sortKey="received"
                sort={sort}
                onSort={onSort}
              />
              <SortTh
                className={`${TH} bg-teal-500/10 text-teal-800 dark:text-teal-200`}
                label="Due"
                sortKey="due"
                sort={sort}
                onSort={onSort}
              >
                <span className="block font-mono text-[10px] font-normal normal-case tracking-[0.04em] opacity-80">
                  SLA
                </span>
              </SortTh>
              <SortTh
                label="Priority"
                sortKey="priority"
                sort={sort}
                onSort={onSort}
              />
              <th className={TH}>Wells</th>
              <th className={`${TH} text-center`}>Flag</th>
              <th className={TH} />
            </tr>
          </thead>
          <tbody>
            {L.list.map((row, i) => {
              const s = row.sample
              const item = s ? byId.get(s.itemId) : undefined
              const a = s?.assessment
              const tint = row.isControl
                ? 'bg-[#d9d9d9]/60 dark:bg-zinc-700/60 font-semibold'
                : doc.sortByOrder && row.group % 2 === 1
                  ? 'bg-[#deeaf6]/40 dark:bg-sky-900/20'
                  : ''
              const wells =
                row.isControl && L.plateCount > 1
                  ? 'every plate'
                  : row.placements[0]
                    ? wellsOf(row.placements[0], L.plateCount)
                    : '-'
              const dueTime =
                s && calendar
                  ? labTime(
                      slaByKey.get(String(s.itemId))?.status.due_at,
                      calendar
                    )
                  : null
              const receivedTime =
                item && calendar ? labTime(item.date_received, calendar) : null
              return (
                <tr
                  key={s ? s.itemId : `npc-${i}`}
                  className={`group/item hover:bg-teal-500/[0.04] ${tint}`}
                >
                  <td
                    className={`${TD} relative pl-3 pr-1.5 text-right font-mono text-[11px] text-muted-foreground before:absolute before:inset-y-0 before:left-0 before:w-[3px] ${a?.flagged ? 'before:bg-[#c00000]' : 'before:bg-transparent'}`}
                    title={a?.reasons.join('; ') || undefined}
                  >
                    {i + 1}
                  </td>
                  <td className={`${TD} ${MONO}`}>{s?.order || '-'}</td>
                  <td className={TD}>
                    {s && item ? (
                      // Not a <button>: the stacked badge carries its own
                      // parent-link button, and a button may not nest one.
                      <span
                        role="link"
                        tabIndex={0}
                        className="inline-block cursor-pointer text-left transition-colors hover:text-primary hover:underline"
                        onClick={() =>
                          useUIStore.getState().navigateToSample(s.id)
                        }
                        onKeyDown={e => {
                          if (e.key === 'Enter')
                            useUIStore.getState().navigateToSample(s.id)
                        }}
                      >
                        <SampleIdBadge
                          stacked
                          id={s.id}
                          variance={item.assignment_kind === 'variance'}
                        />
                      </span>
                    ) : (
                      <span className="font-mono text-[12.5px]">
                        {row.placements[0]?.id ?? 'NPC'}
                      </span>
                    )}
                  </td>
                  <td className={`${TD} text-center`}>
                    {item && (
                      <Tick
                        label="Made"
                        at={item.made_at}
                        byUserId={item.made_by_user_id}
                        users={users}
                        disabled={isCompleted}
                        onToggle={on => onUpdateItem(item.id, { made: on })}
                      />
                    )}
                  </td>
                  <td className={`${TD} text-center`}>
                    {item && (
                      <Tick
                        label="Ran on QuantStudio"
                        at={item.ran_at}
                        byUserId={item.ran_by_user_id}
                        users={users}
                        disabled={isCompleted}
                        onToggle={on => onUpdateItem(item.id, { ran: on })}
                      />
                    )}
                  </td>
                  <td className={`${TD} max-w-[180px]`}>
                    <span
                      className="block truncate"
                      title={s?.identity ?? row.placements[0]?.identity}
                    >
                      {s ? s.identity || '-' : row.placements[0]?.identity}
                    </span>
                  </td>
                  <td className={`${TD} ${MONO} whitespace-nowrap`}>
                    {s ? shortLabDate(s.received) : ''}
                    {receivedTime && (
                      <span className={SUBTIME}>{receivedTime}</span>
                    )}
                  </td>
                  <td
                    className={`${TD} bg-teal-500/[0.06] font-medium whitespace-nowrap`}
                  >
                    {s && (
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className={`${MONO} ${a?.urgency === 'overdue' ? 'font-bold text-[#c00000] dark:text-red-300' : a?.urgency === 'today' ? 'font-bold text-[#bf6a00] dark:text-orange-300' : ''}`}
                        >
                          {shortLabDate(a?.due ?? null)}
                          {dueTime && (
                            <span className={SUBTIME}>{dueTime}</span>
                          )}
                        </span>
                        <SlaAgeIndicator
                          snapshot={slaByKey.get(String(s.itemId)) ?? null}
                          isLoading={slaLoading}
                          isError={slaError}
                          compact
                        />
                      </span>
                    )}
                  </td>
                  <td className={TD}>
                    {s && <PriorityChip priority={s.priority} />}
                  </td>
                  <td
                    className={`${TD} ${MONO} whitespace-nowrap text-muted-foreground`}
                    title={row.placements
                      .map(
                        p =>
                          `Plate ${p.plate}: ${p.row}${p.col} / ${p.row}${p.col + 6}${p.frozen ? ' (locked)' : ''}`
                      )
                      .join('\n')}
                  >
                    {wells}
                    {row.placements[0]?.frozen && (
                      <span
                        className="ml-1 text-[10px] text-amber-600"
                        title="Locked well"
                      >
                        locked
                      </span>
                    )}
                  </td>
                  <td className={`${TD} text-center`}>
                    {item && <FlagCell item={item} />}
                  </td>
                  <td className={`${TD} whitespace-nowrap text-right`}>
                    {item && !isCompleted && (
                      <span className="inline-flex items-center gap-1">
                        <button
                          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/item:opacity-100 focus-visible:opacity-100"
                          aria-label={`Remove ${item.sample_id} from worksheet`}
                          title={
                            row.placements[0]?.frozen
                              ? 'Remove this sample (its locked well stays empty; it goes back to the inbox)'
                              : 'Remove this sample (it goes back to the inbox)'
                          }
                          onClick={() => onRemove(item.id)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    )}
                    {row.isControl && (
                      <span
                        className="rounded-[2px] border bg-muted px-1 text-[9.5px] font-bold uppercase tracking-[0.05em] text-muted-foreground"
                        title="The NPC is always on the plate, after the last sample. It is added for you and cannot be removed."
                      >
                        auto
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default PcrSampleList

/** A list header that sorts the run (and so re-deals the plate) on click. */
function SortTh({
  label,
  sortKey,
  sort,
  onSort,
  className = TH,
  children,
}: {
  label: string
  sortKey: PcrSortKey
  sort: PcrSort
  onSort?: (next: PcrSort) => void
  className?: string
  children?: ReactNode
}) {
  const active = sort.key === sortKey
  const listed = sortKey === 'listed'
  const Icon = !active
    ? ChevronsUpDown
    : sort.dir === 'asc'
      ? ArrowUp
      : ArrowDown
  return (
    <th
      className={className}
      aria-sort={
        active && !listed
          ? sort.dir === 'asc'
            ? 'ascending'
            : 'descending'
          : 'none'
      }
    >
      {onSort ? (
        <button
          type="button"
          onClick={() => onSort(nextSort(sort, sortKey))}
          className={`inline-flex items-center gap-1 uppercase transition-colors hover:text-foreground ${active ? 'text-foreground' : ''}`}
          title={
            listed
              ? 'Worksheet order: samples as they were added. The plate follows.'
              : `Sort by ${label.toLowerCase()}. The plate is dealt in the list's order; locked wells never move.`
          }
        >
          {label}
          {!listed && (
            <Icon
              className={`h-3 w-3 ${active ? '' : 'opacity-40'}`}
              aria-hidden="true"
            />
          )}
        </button>
      ) : label === '#' ? null : (
        label
      )}
      {children}
    </th>
  )
}
