import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
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
} from '@/lib/api'
import { displayName, shortName } from '@/lib/user-display'
import { worksheetItemSlaSubjects } from '@/lib/worksheet-sla-subjects'
import { useSlaForSubjects } from '@/services/sla-subjects'
import { EntityFlagButton } from '@/components/flags/EntityFlagButton'
import { useRegisterActiveFlagEntity } from '@/components/flags/use-active-flag-entity'
import { EndoWorksheetActions } from './EndoWorksheetActions'
import { EndoCalculations, EndoWorksheetTable } from './EndoWorksheetTable'

/**
 * The main column of the flyout for an endotoxin worksheet, laid out as
 * Dennis's tool: the run title and its actions, then the sheet (meta strip,
 * table, totals), the calculations, and the worksheet notes. The generic
 * header / item list stay in charge of every other kind of worksheet.
 */
export function EndoWorksheetView({
  worksheet,
  users,
  userNotes,
  isCompleted,
  otherWorksheets,
  applyBar,
  completeAction,
  onAddSamples,
  onUpdate,
  onRemove,
  onReassign,
  onUpdateItem,
  onTickAll,
}: {
  worksheet: WorksheetListItem
  users: WorksheetUser[]
  userNotes: string
  isCompleted: boolean
  otherWorksheets: WorksheetListItem[]
  /** The method + instrument "apply to all" bar, when the worksheet is open. */
  applyBar: ReactNode
  completeAction: ReactNode
  onAddSamples: () => void
  onUpdate: (data: {
    title?: string
    assigned_analyst?: number
    notes?: string
  }) => void
  onRemove: (itemId: number) => void
  onReassign: (itemId: number, targetWorksheetId: number) => void
  onUpdateItem: (itemId: number, data: WorksheetItemPatch) => void
  onTickAll: (data: { made?: boolean; ran?: boolean }) => void
}) {
  useRegisterActiveFlagEntity(
    'worksheet',
    String(worksheet.id),
    worksheet.title || `Worksheet ${worksheet.id}`
  )
  const {
    byKey: slaByKey,
    isLoading: slaLoading,
    isError: slaError,
  } = useSlaForSubjects(
    worksheetItemSlaSubjects(
      worksheet.items,
      isCompleted ? (worksheet.completed_at ?? null) : null
    )
  )

  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  function saveTitle() {
    const next = (titleDraft ?? '').trim()
    setTitleDraft(null)
    if (next && next !== worksheet.title) onUpdate({ title: next })
  }

  const analyst = users.find(u => u.id === worksheet.assigned_analyst)
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

  // Block flow, not a flex column: flexbox would shrink the sheet card
  // (overflow-hidden, so min-height 0) to fit instead of letting this column
  // scroll, clipping rows on a long run or a short screen.
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
              onBlur={saveTitle}
              onKeyDown={e => {
                if (e.key === 'Enter') saveTitle()
                if (e.key === 'Escape') setTitleDraft(null)
              }}
            />
          )}
          <span className="font-mono text-xs tracking-wide text-muted-foreground">
            WS-{worksheet.id} · {worksheet.status} · {printed}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <EntityFlagButton
            entityType="worksheet"
            entityId={String(worksheet.id)}
          />
          <EndoWorksheetActions worksheet={worksheet} users={users} />
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

      <EndoWorksheetTable
        items={worksheet.items}
        isCompleted={isCompleted}
        createdAt={worksheet.created_at}
        users={users}
        analyst={
          isCompleted ? (
            <span className="text-sm font-medium">
              {analyst
                ? displayName(analyst)
                : (worksheet.assigned_analyst_email ?? '-')}
            </span>
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
          )
        }
        slaByKey={slaByKey}
        slaLoading={slaLoading}
        slaError={slaError}
        otherWorksheets={otherWorksheets}
        onRemove={onRemove}
        onReassign={onReassign}
        onUpdateItem={onUpdateItem}
        onTickAll={onTickAll}
      />

      <EndoCalculations />

      <section>
        <h3 className="pb-2 text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
          Notes
        </h3>
        {isCompleted ? (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {userNotes || '-'}
          </p>
        ) : (
          <Textarea
            key={worksheet.id}
            className="min-h-[60px] resize-none bg-card text-sm"
            placeholder="Add notes…"
            defaultValue={userNotes}
            onBlur={e => {
              if (e.target.value !== userNotes)
                onUpdate({ notes: e.target.value })
            }}
          />
        )}
      </section>
    </div>
  )
}

export default EndoWorksheetView
