import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  getInstruments,
  getWorksheetUsers,
  type WorksheetListItem,
  type WorksheetUpdate,
} from '@/lib/api'
import { displayName } from '@/lib/user-display'
import { parseWorksheetNotes, withNotesText } from '@/lib/worksheet-notes'
import { useWorksheetDrawer } from '@/hooks/use-worksheet-drawer'
import { useHplcPrepRules } from '@/services/hplc-prep-rules'
import {
  HPLC_SHEET_KEY,
  useHplcSheet,
  usePatchHplcRow,
  useSetHplcInstrument,
} from '@/services/hplc-worksheet'
import AddSamplesModal from '@/components/hplc/AddSamplesModal'
import { CompleteWorksheetButton } from '@/components/hplc/WorksheetDrawer'
import { HplcPrepSheet } from './HplcPrepSheet'
import { CellSelect } from './HplcSheetCells'

const FIVE_MINUTES = 5 * 60 * 1000

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
  const patch = usePatchHplcRow(id)
  const instrument = useSetHplcInstrument(id)
  // A first load that failed leaves every row on the method standard.
  const { data: rules = [] } = useHplcPrepRules()
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
  const saveError = patch.error ?? instrument.error

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

      {saveError && (
        <p
          role="alert"
          className="rounded-[5px] border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          Not saved: {saveError.message}
        </p>
      )}

      {sheet.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : sheet.isError || !sheet.data ? (
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
        <HplcPrepSheet
          sheet={sheet.data}
          rules={rules}
          readOnly={isCompleted}
          instruments={instruments.filter(i => i.active)}
          onPatch={(itemId, body) => patch.mutate({ itemId, body })}
          onSetInstrument={(itemId, instrumentId) =>
            instrument.mutate({ itemId, instrumentId })
          }
        />
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
