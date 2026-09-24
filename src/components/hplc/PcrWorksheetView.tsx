import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type {
  WorksheetItemPatch,
  WorksheetListItem,
  WorksheetUser,
  WorksheetWellFreeze,
} from '@/lib/api'
import { labDate } from '@/lib/endo-prep'
import { shortLabDate } from '@/lib/endo-worksheet'
import {
  buildPcrRunDoc,
  isPcrWorksheetItem,
  pcrConfigOf,
  pcrConfigToWire,
  type PcrConfig,
} from '@/lib/pcr-worksheet'
import { displayName, shortName } from '@/lib/user-display'
import { worksheetNotesText } from '@/lib/worksheet-notes'
import { worksheetItemSlaSubjects } from '@/lib/worksheet-sla-subjects'
import { useLabCalendar } from '@/hooks/use-lab-calendar'
import { useSlaForSubjects } from '@/services/sla-subjects'
import { EntityFlagButton } from '@/components/flags/EntityFlagButton'
import { useRegisterActiveFlagEntity } from '@/components/flags/use-active-flag-entity'
import { PcrCalculations } from './PcrCalculations'
import { PcrPlateMap } from './PcrPlateMap'
import { PcrSampleList } from './PcrSampleList'
import { PcrWorksheetActions } from './PcrWorksheetActions'
import { WorksheetNoteLog } from './WorksheetNoteLog'

const MONO = 'font-mono text-[12.5px] tabular-nums'
const FIELD =
  'h-6 w-full rounded-[3px] border border-transparent bg-transparent px-1 text-sm font-medium hover:border-border focus:border-teal-500 focus:outline-none'

/**
 * The main column of the flyout for a PCR worksheet, laid out as Dennis's
 * plate builder: the run title and its actions, the run header (fields, run
 * status, run parameters), the samples list across the full width, then
 * each plate map with its calculations panel under it, and the notes log.
 * The generic header and item list stay in charge of every other kind of
 * worksheet.
 */
export function PcrWorksheetView({
  worksheet,
  users,
  userNotes,
  isCompleted,
  applyBar,
  completeAction,
  onAddSamples,
  onUpdate,
  onRemove,
  onUpdateItem,
  onTickAll,
  onFreeze,
  onUnfreeze,
  onAddNote,
}: {
  worksheet: WorksheetListItem
  users: WorksheetUser[]
  userNotes: string
  isCompleted: boolean
  applyBar: ReactNode
  completeAction: ReactNode
  onAddSamples: () => void
  onUpdate: (data: {
    title?: string
    assigned_analyst?: number
    notes?: string
    bench_config?: Record<string, unknown>
  }) => void
  onRemove: (itemId: number) => void
  /** One row's Made / Ran tick (the server stamps who and when). */
  onUpdateItem: (itemId: number, data: WorksheetItemPatch) => void
  onTickAll: (data: { made?: boolean; ran?: boolean }) => void
  onFreeze: (wells: WorksheetWellFreeze[]) => Promise<unknown>
  onUnfreeze: () => void
  /** Append a note; the server stamps who and when. Rejects with the reason. */
  onAddNote: (body: string) => Promise<unknown>
}) {
  useRegisterActiveFlagEntity(
    'worksheet',
    String(worksheet.id),
    worksheet.title || `Worksheet ${worksheet.id}`
  )
  const { calendar } = useLabCalendar()
  const pcrItems = worksheet.items.filter(isPcrWorksheetItem)
  const {
    byKey: slaByKey,
    isLoading: slaLoading,
    isError: slaError,
  } = useSlaForSubjects(
    worksheetItemSlaSubjects(
      pcrItems,
      isCompleted ? (worksheet.completed_at ?? null) : null
    )
  )
  const analyst = users.find(u => u.id === worksheet.assigned_analyst)
  const analystName = analyst
    ? displayName(analyst)
    : (worksheet.assigned_analyst_email ?? '')
  const cfg = pcrConfigOf(worksheet)
  const buildDoc = () =>
    buildPcrRunDoc(worksheet, {
      analystName,
      calendar,
      printedAt: new Date().toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
      dueAtByItemId: new Map(
        pcrItems.map(it => [
          it.id,
          slaByKey.get(String(it.id))?.status.due_at ?? null,
        ])
      ),
      notes: worksheetNotesText(worksheet.note_log ?? [], userNotes, calendar),
    })
  const doc = buildDoc()
  const L = doc.layout
  const setConfig = (patch: Partial<PcrConfig>) =>
    onUpdate({ bench_config: pcrConfigToWire({ ...cfg, ...patch }) })

  // Enter saves; Escape or clicking away cancels (see EndoWorksheetView for
  // why nothing saves on blur).
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  function saveTitle() {
    const next = (titleDraft ?? '').trim()
    setTitleDraft(null)
    if (next && next !== worksheet.title) onUpdate({ title: next })
  }

  const printedBy = users.find(u => u.id === worksheet.printed_by_user_id)
  const printed = worksheet.printed_at
    ? `printed ${new Date(worksheet.printed_at).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })}${printedBy ? ` by ${shortName(printedBy)}` : ''}${
        (worksheet.print_count ?? 0) > 1 ? ` (${worksheet.print_count}x)` : ''
      }`
    : 'not printed yet'
  const total = doc.status.total
  const allMade = total > 0 && doc.status.made === total
  const allRan = total > 0 && doc.status.ran === total

  return (
    <div className="min-w-0 flex-1 space-y-4 overflow-y-auto px-6 pb-8 pt-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {titleDraft === null ? (
            <h2 className="truncate text-[23px] font-semibold leading-tight tracking-tight">
              {worksheet.title}
            </h2>
          ) : (
            <input
              autoFocus
              aria-label="Worksheet title"
              className="w-[22rem] max-w-full rounded-[5px] border bg-background px-2 py-1 text-xl font-semibold focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={() => setTitleDraft(null)}
              onKeyDown={e => {
                if (e.key === 'Enter') saveTitle()
                if (e.key === 'Escape') setTitleDraft(null)
              }}
            />
          )}
          <span className="font-mono text-xs tracking-wide text-muted-foreground">
            WS-{worksheet.id} · {worksheet.status} · {printed}
            {L.frozenCount > 0 &&
              ` · ${L.frozenCount} well${L.frozenCount === 1 ? '' : 's'} locked`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <EntityFlagButton
            entityType="worksheet"
            entityId={String(worksheet.id)}
          />
          <PcrWorksheetActions
            worksheetId={worksheet.id}
            buildDoc={buildDoc}
            ready={!!calendar}
            isCompleted={isCompleted}
            onFreeze={onFreeze}
          />
          {!isCompleted && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTitleDraft(worksheet.title)}
              >
                Rename
              </Button>
              {completeAction}
              <Button
                size="sm"
                className="bg-teal-600 text-white hover:bg-teal-600/90"
                onClick={onAddSamples}
              >
                Add samples
              </Button>
            </>
          )}
        </div>
      </div>

      {applyBar && (
        <div className="overflow-hidden rounded-[5px] border bg-card">
          {applyBar}
        </div>
      )}

      {/* Run header: Dennis's meta block, run status and run parameters. */}
      <div className="overflow-hidden rounded-[5px] border bg-card shadow-sm">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] border-b">
          <Meta label="Analyst">
            {isCompleted ? (
              <span className="text-sm font-medium">{analystName || '-'}</span>
            ) : (
              <Select
                value={
                  worksheet.assigned_analyst
                    ? String(worksheet.assigned_analyst)
                    : undefined
                }
                onValueChange={v => onUpdate({ assigned_analyst: Number(v) })}
              >
                <SelectTrigger
                  aria-label="Analyst"
                  className="h-6 w-full border-0 bg-transparent p-0 text-sm font-medium shadow-none focus:ring-0"
                >
                  <SelectValue placeholder="Assign analyst…" />
                </SelectTrigger>
                <SelectContent>
                  {users.map(u => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {displayName(u)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Meta>
          <Meta label="Date made">
            <span className={MONO}>
              {shortLabDate(
                calendar ? labDate(worksheet.created_at, calendar) : null
              )}
            </span>
          </Meta>
          <Meta label="Curve">
            <ConfigField
              key={`curve-${worksheet.id}-${cfg.curve}`}
              value={cfg.curve}
              placeholder="P/A"
              options={['P/A', 'Quantitative']}
              disabled={isCompleted}
              onCommit={v => setConfig({ curve: v })}
            />
          </Meta>
          <Meta label="Plate type">
            <ConfigField
              key={`plate-${worksheet.id}-${cfg.plateType}`}
              value={cfg.plateType}
              placeholder="8-Well Strip"
              options={['8-Well Strip', '96-Well Plate']}
              disabled={isCompleted}
              onCommit={v => setConfig({ plateType: v })}
            />
          </Meta>
          <Meta
            label="QuantStudio"
            title="Recorded on every row by the Ran tick"
          >
            <span className="truncate text-sm font-medium">
              {doc.meta.instrument || (
                <span className="text-muted-foreground">not stamped yet</span>
              )}
            </span>
          </Meta>
          <Meta label="Samples">
            <span className={MONO}>{doc.summary.samples}</span>
          </Meta>
          <Meta label="Plates">
            <span className={MONO}>{L.plateCount}</span>
          </Meta>
          <Meta
            label="Earliest due"
            title="The earliest SLA due date on this run"
          >
            <span
              className={`${MONO} ${doc.summary.overdue ? 'font-bold text-[#c00000]' : doc.summary.today ? 'font-bold text-[#bf6a00]' : ''}`}
            >
              {shortLabDate(doc.summary.earliestDue)}
            </span>
          </Meta>
          <Meta label="Priority" title="Marked priority, overdue, or due today">
            <span
              className={`text-sm ${doc.summary.flagged ? 'font-bold text-[#c00000]' : ''}`}
            >
              {doc.summary.prioText}
            </span>
          </Meta>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 bg-muted/60 px-3.5 py-2.5">
          <span className="text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
            Run status
          </span>
          <RunTick
            label="Plate made"
            count={`${doc.status.made}/${total}`}
            checked={allMade}
            disabled={isCompleted || total === 0}
            onSet={() => onTickAll({ made: true })}
          />
          <RunTick
            label="Ran on QuantStudio"
            count={`${doc.status.ran}/${total}`}
            checked={allRan}
            disabled={isCompleted || total === 0}
            onSet={() => onTickAll({ ran: true })}
          />
          <span className="flex-1" />
          <span className="text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
            Run parameters
          </span>
          <label
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            title="Applied to assay and IPC mix components only, matching the workbook. Master mix is not scaled: the well counts already carry a +4 / +2 buffer."
          >
            Overage
            <input
              key={`overage-${worksheet.id}-${cfg.overage}`}
              type="number"
              min={1}
              max={3}
              step={0.1}
              defaultValue={cfg.overage}
              disabled={isCompleted}
              aria-label="Overage factor"
              className="h-6 w-14 rounded-[3px] border bg-card px-1 text-right font-mono text-[12.5px] text-foreground"
              onKeyDown={e => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              onBlur={e => {
                const v = Number(e.target.value)
                if (Number.isFinite(v) && v > 0 && v !== cfg.overage)
                  setConfig({ overage: v })
                else e.target.value = String(cfg.overage)
              }}
            />
            ×
          </label>
          <label
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            title="Lay the plate out by order number. Untick to place samples exactly as listed on the worksheet. Locked wells never move either way."
          >
            <Checkbox
              checked={cfg.sortByOrder}
              disabled={isCompleted}
              onCheckedChange={v => setConfig({ sortByOrder: v === true })}
            />
            Order wells by order #
          </label>
        </div>
      </div>

      {/* Samples across the top, then each plate with its calculations
          (Handler, 2026-09-23): the list reads full width, not as a column. */}
      <div className="space-y-4">
        <PcrSampleList
          doc={doc}
          items={pcrItems}
          calendar={calendar}
          slaByKey={slaByKey}
          slaLoading={slaLoading}
          slaError={slaError}
          isCompleted={isCompleted}
          onRemove={onRemove}
          users={users}
          onUpdateItem={onUpdateItem}
        />
        <div className="min-w-0 space-y-4">
          {L.plates.map(pl => (
            <div key={pl.plate} className="space-y-3">
              <PcrPlateMap
                plate={pl}
                plateCount={L.plateCount}
                outlineGroups={cfg.sortByOrder}
                frozenCount={L.frozenCount}
                isCompleted={isCompleted}
                onUnfreeze={onUnfreeze}
              />
              <section>
                <h3 className="pb-2 text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                  Calculations{L.plateCount > 1 ? `: plate ${pl.plate}` : ''}
                </h3>
                <PcrCalculations wells={pl.n} overage={cfg.overage} />
              </section>
            </div>
          ))}
        </div>
      </div>

      <section>
        <h3 className="pb-2 text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
          Notes
        </h3>
        <WorksheetNoteLog
          key={worksheet.id}
          notes={worksheet.note_log ?? []}
          legacyText={userNotes}
          isCompleted={isCompleted}
          calendar={calendar}
          onAdd={onAddNote}
        />
      </section>
    </div>
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

/** A free-text run setting with suggestions; Enter or leaving the field saves. */
function ConfigField({
  value,
  placeholder,
  options,
  disabled,
  onCommit,
}: {
  value: string
  placeholder: string
  options: string[]
  disabled: boolean
  onCommit: (v: string) => void
}) {
  const listId = `pcr-opts-${placeholder.replace(/\W+/g, '-')}`
  if (disabled)
    return <span className="text-sm font-medium">{value || '-'}</span>
  return (
    <>
      <input
        type="text"
        list={listId}
        defaultValue={value}
        placeholder={placeholder}
        aria-label={placeholder}
        className={FIELD}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        onBlur={e => {
          const v = e.target.value.trim()
          if (v !== value) onCommit(v)
        }}
      />
      <datalist id={listId}>
        {options.map(o => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  )
}

/** A run-level tick: sets (or clears) Made / Ran on every row at once. */
/**
 * A run-level tick: sets Made / Ran on every row still open. It only ever
 * sets, like the endo sheet's tick-all headings (Handler, 2026-09-23): one
 * slip must not wipe a whole run's who/when stamps, so once every row is
 * ticked the box stays ticked.
 */
export function RunTick({
  label,
  count,
  checked,
  disabled,
  onSet,
}: {
  label: string
  count: string
  checked: boolean
  disabled: boolean
  onSet: () => void
}) {
  return (
    <label
      className="flex items-center gap-1.5 text-sm"
      title={checked ? `${label}: every row is ticked` : undefined}
    >
      <Checkbox
        checked={checked}
        disabled={disabled || checked}
        aria-label={label}
        onCheckedChange={v => {
          if (v === true) onSet()
        }}
      />
      {label}
      <span className="font-mono text-[11px] text-muted-foreground">
        {count}
      </span>
    </label>
  )
}

export default PcrWorksheetView
