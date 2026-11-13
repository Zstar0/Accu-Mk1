import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  getInstruments,
  getWorksheetUsers,
  type HplcSheet,
  type WorksheetListItem,
  type WorksheetUpdate,
} from '@/lib/api'
import { promoteReasons, REASON_COMPLETED } from '@/lib/hplc-promote'
import { displayName } from '@/lib/user-display'
import { parseWorksheetNotes, withNotesText } from '@/lib/worksheet-notes'
import { useWorksheetDrawer } from '@/hooks/use-worksheet-drawer'
import type { HplcPrepRule } from '@/lib/hplc-prep-rules'
import { useHplcPrepRules } from '@/services/hplc-prep-rules'
import {
  HPLC_SHEET_KEY,
  useHplcSheet,
  useHplcSheetSaving,
  usePatchHplcRow,
  usePromoteHplcRow,
  useSetHplcInstrument,
} from '@/services/hplc-worksheet'
import AddSamplesModal from '@/components/hplc/AddSamplesModal'
import { CompleteWorksheetButton } from '@/components/hplc/WorksheetDrawer'
import {
  HplcPrepSheet,
  sheetRowViews,
  type SheetRowView,
} from './HplcPrepSheet'
import { HplcPromoteCell } from './HplcPromoteCell'
import { CellSelect } from './HplcSheetCells'

const FIVE_MINUTES = 5 * 60 * 1000
const NO_RULES: HplcPrepRule[] = []

/**
 * The HPLC prep worksheet as a page (plan 2026-11-12-hplc-prep-worksheet):
 * the endo page's header shell (title, analyst, Add samples, Complete,
 * notes) over the analyst's sheet, read from GET /worksheets/{id}/hplc.
 * WorksheetPage picks it for an all-HPLC worksheet.
 */
export function HplcWorksheetPage({
  worksheet,
}: {
  worksheet: WorksheetListItem
}) {
  const id = worksheet.id
  const drawer = useWorksheetDrawer()
  const queryClient = useQueryClient()
  const [addSamplesOpen, setAddSamplesOpen] = useState(false)
  const sheet = useHplcSheet(id)
  // Every save that did not land, until dismissed: a later save that lands
  // never clears an earlier failure.
  const [failures, setFailures] = useState<{ n: number; text: string }[]>([])
  const failureSeq = useRef(0)
  const onFailure = (what: string, reason: string) =>
    setFailures(f => [
      ...f,
      { n: ++failureSeq.current, text: `${what}: ${reason}` },
    ])
  const patch = usePatchHplcRow(id, onFailure)
  const instrument = useSetHplcInstrument(id, onFailure)
  const saving = useHplcSheetSaving(id)
  const { promote, readFresh } = usePromoteHplcRow(id)
  // A first load that failed leaves every row on the method standard.
  // One empty list, so the sheet's row views stay memoised while it loads.
  const rules = useHplcPrepRules().data ?? NO_RULES
  const { data: users = [] } = useQuery({
    queryKey: ['worksheet-users'],
    queryFn: getWorksheetUsers,
    staleTime: FIVE_MINUTES,
  })
  const { data: instruments = [] } = useQuery({
    queryKey: ['instruments'],
    queryFn: getInstruments,
    staleTime: FIVE_MINUTES,
  })
  // The drawer's mutations refresh the worksheet; the sheet has its own key.
  const refreshSheet = {
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: HPLC_SHEET_KEY(id) }),
  }
  const isCompleted =
    worksheet.status === 'completed' || sheet.data?.status === 'completed'
  const { userNotes } = parseWorksheetNotes(worksheet.notes ?? '')

  /** Why a row cannot be promoted, on this copy of the sheet. */
  const reasonsOf = (s: HplcSheet, v: SheetRowView) =>
    s.status === 'completed' || worksheet.status === 'completed'
      ? [REASON_COMPLETED]
      : promoteReasons(v.row, v.computed, s.blend_cap)

  /** A press: the row's reasons, and what the prep will record, from the
   *  sheet and the rules as the server has them now. */
  async function check(itemId: number) {
    const fresh = await readFresh()
    if (!fresh) return null
    const v = sheetRowViews(fresh.sheet, fresh.rules, false).find(
      x => x.row.item_id === itemId
    )
    if (!v || v.row.promoted) return null
    return { reasons: reasonsOf(fresh.sheet, v), computed: v.computed }
  }

  // N of M promoted: M counts the rows that can have a prep
  const preppable = sheet.data?.rows.filter(r => !r.rider_only) ?? []

  function update(data: WorksheetUpdate) {
    drawer.updateMutation.mutate({
      worksheetId: id,
      data:
        data.notes === undefined
          ? data
          : {
              ...data,
              notes: withNotesText(worksheet.notes ?? '', data.notes),
            },
    })
  }

  return (
    <div className="h-full min-h-0 space-y-4 overflow-y-auto bg-muted/30 px-6 pb-8 pt-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-[23px] font-semibold leading-tight tracking-tight">
            {worksheet.title}
          </h2>
          <span className="font-mono text-xs tracking-wide text-muted-foreground">
            WS-{id} · {worksheet.status} · HPLC
          </span>
          {sheet.data && (
            <span className="ml-3 text-xs text-muted-foreground">
              {`${preppable.filter(r => r.promoted).length} of ${preppable.length} promoted`}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isCompleted ? (
            <span className="text-sm">
              {displayName(
                users.find(u => u.id === worksheet.assigned_analyst) ?? {
                  email: worksheet.assigned_analyst_email ?? '-',
                }
              )}
            </span>
          ) : (
            <>
              <CellSelect
                label="Analyst"
                value={
                  worksheet.assigned_analyst
                    ? String(worksheet.assigned_analyst)
                    : ''
                }
                disabled={false}
                options={[
                  ['', 'Assign analyst…'],
                  ...users.map(
                    u => [String(u.id), displayName(u)] as [string, string]
                  ),
                ]}
                onChange={v => v && update({ assigned_analyst: Number(v) })}
              />
              <CompleteWorksheetButton
                onConfirm={() =>
                  drawer.completeMutation.mutate(id, refreshSheet)
                }
              />
              <Button
                size="sm"
                className="bg-teal-600 text-white hover:bg-teal-600/90"
                onClick={() => setAddSamplesOpen(true)}
              >
                Add samples
              </Button>
            </>
          )}
        </div>
      </div>

      {failures.map(f => (
        <p
          key={f.n}
          role="alert"
          className="flex items-center justify-between gap-3 rounded-[5px] border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          <span>Not saved: {f.text}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFailures(all => all.filter(x => x.n !== f.n))}
          >
            Dismiss
          </Button>
        </p>
      ))}

      {sheet.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : !sheet.data ? (
        <p className="flex items-center gap-3 text-sm text-muted-foreground">
          Could not load the HPLC sheet.
          <Button
            variant="outline"
            size="sm"
            onClick={() => void sheet.refetch()}
          >
            Retry
          </Button>
        </p>
      ) : (
        <>
          {/* A read-again that failed keeps the sheet, and every draft in it. */}
          {sheet.isError && (
            <p
              role="status"
              className="flex items-center gap-3 rounded-[5px] border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-800 dark:text-amber-200"
            >
              Could not refresh the sheet; what you see may be out of date
              <Button
                variant="outline"
                size="sm"
                onClick={() => void sheet.refetch()}
              >
                Retry
              </Button>
            </p>
          )}
          <HplcPrepSheet
            sheet={sheet.data}
            rules={rules}
            readOnly={isCompleted}
            instruments={instruments.filter(i => i.active)}
            onPatch={(itemId, body, what) =>
              patch.mutate({ itemId, body, what })
            }
            onSetInstrument={(itemId, instrumentId, what) =>
              instrument.mutate({ itemId, instrumentId, what })
            }
            onNumberRefused={onFailure}
            step2Trailing={{
              header: 'Sample prep',
              cell: v => (
                <HplcPromoteCell
                  view={v}
                  reasons={reasonsOf(sheet.data as HplcSheet, v)}
                  saving={saving}
                  check={() => check(v.row.item_id)}
                  promote={() => promote.mutateAsync(v.row.item_id)}
                />
              ),
            }}
          />
        </>
      )}

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
            className="min-h-[60px] resize-none bg-card text-sm"
            placeholder="Add notes…"
            defaultValue={userNotes}
            onBlur={e => {
              if (e.target.value !== userNotes)
                update({ notes: e.target.value })
            }}
          />
        )}
      </section>

      <AddSamplesModal
        open={addSamplesOpen}
        onOpenChange={setAddSamplesOpen}
        worksheetId={id}
        existingItems={worksheet.items}
        onAdd={data =>
          drawer.addItemMutation.mutate({ worksheetId: id, data }, refreshSheet)
        }
      />
    </div>
  )
}

export default HplcWorksheetPage
