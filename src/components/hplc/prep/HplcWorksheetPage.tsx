import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
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
import { useHplcPrepRules } from '@/services/hplc-prep-rules'
import {
  HPLC_SHEET_KEY,
  isRowKey,
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

/** One line of the failure list. */
interface Failure {
  n: number
  /** "<sample id>, <column>: <reason>" */
  text: string
  /** The boxKeys of the values it wrote (empty: none known). */
  keys: string[]
}

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
  // Every save that did not land, and every number a box refused, until
  // dismissed or until that same box saves (or, refused, holds a value it
  // takes): a save of another box never clears it. `keys` are the boxKeys
  // of the values it wrote; a row with one on the list cannot be promoted.
  const [failures, setFailuresState] = useState<Failure[]>([])
  // the list as of now, for a promote about to go (it reads it after the
  // saves queued before it have answered, before a re-render)
  const failuresNow = useRef<Failure[]>([])
  const setFailures = (fn: (f: Failure[]) => Failure[]) => {
    failuresNow.current = fn(failuresNow.current)
    setFailuresState(failuresNow.current)
  }
  const failureSeq = useRef(0)
  // a failure that answers after the tech left the page is a toast
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const onFailure = (what: string, reason: string, keys: string[]) => {
    const text = `${what}: ${reason}`
    if (!mounted.current) {
      toast.error(`Not saved: ${text}`)
      return
    }
    setFailures(f => [...f, { n: ++failureSeq.current, text, keys }])
  }
  const clearKeys = (keys: string[]) => {
    if (failuresNow.current.some(f => f.keys.some(k => keys.includes(k))))
      setFailures(f => f.filter(x => !x.keys.some(k => keys.includes(k))))
  }
  const onNumberRefused = (
    what: string,
    reason: string | null,
    key?: string
  ) =>
    reason === null
      ? key && clearKeys([key])
      : onFailure(what, reason, key ? [key] : [])
  /** Why this row cannot be promoted while the list holds one of its
   *  boxes; null when it holds none. */
  const unsavedOf = (list: Failure[], itemId: number) => {
    const f = list.find(x => x.keys.some(k => isRowKey(k, itemId)))
    return f
      ? `A change to this row was not saved: ${f.text.replace(/\.$/, '')}. Type it again or dismiss it, then promote.`
      : null
  }
  const failed = useMemo(() => {
    const m = new Map<string, string>()
    for (const f of failures)
      for (const k of f.keys) if (!m.has(k)) m.set(k, f.text)
    return m
  }, [failures])
  const patch = usePatchHplcRow(id, onFailure, clearKeys)
  const instrument = useSetHplcInstrument(id, onFailure, clearKeys)
  const saving = useHplcSheetSaving(id)
  const { promote, readFresh } = usePromoteHplcRow(id, itemId =>
    unsavedOf(failuresNow.current, itemId)
  )
  // typed work still on its way: leaving the page asks first
  useEffect(() => {
    if (!saving) return
    const ask = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [saving])
  // The sheet is never worked out without its rules: it waits for their
  // first load, and a failed one shows Retry, not tables (with no rules a
  // GHK-Cu stock would read as plain water). A read-again that fails keeps
  // the rules on screen and says they may be out of date.
  const rulesQuery = useHplcPrepRules()
  const rules = rulesQuery.data
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

      {failures.length > 0 && (
        // stays in view while the sheet scrolls, above its sticky Sample
        // ID cells (z-10); opaque, so the rows do not show through
        <div className="sticky top-0 z-20 space-y-2 bg-background py-1">
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
        </div>
      )}

      {sheet.isLoading || (rules === undefined && !rulesQuery.isError) ? (
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
      ) : rules === undefined ? (
        <p className="flex items-center gap-3 text-sm text-muted-foreground">
          Could not load the prep rules, so the sheet cannot be worked out.
          <Button
            variant="outline"
            size="sm"
            onClick={() => void rulesQuery.refetch()}
          >
            Retry
          </Button>
        </p>
      ) : (
        <>
          {/* A read-again of the sheet or the rules that failed keeps the
              sheet, and every draft in it. */}
          {(sheet.isError || rulesQuery.isError) && (
            <p
              role="status"
              className="flex items-center gap-3 rounded-[5px] border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-800 dark:text-amber-200"
            >
              Could not refresh the sheet; what you see may be out of date
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (sheet.isError) void sheet.refetch()
                  if (rulesQuery.isError) void rulesQuery.refetch()
                }}
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
            onNumberRefused={onNumberRefused}
            failed={failed}
            step2Trailing={{
              header: 'Sample prep',
              cell: v => (
                <HplcPromoteCell
                  view={v}
                  reasons={reasonsOf(sheet.data as HplcSheet, v)}
                  unsaved={unsavedOf(failures, v.row.item_id)}
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
