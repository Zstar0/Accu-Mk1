import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  getInstruments,
  getMethods,
  getWorksheet,
  getWorksheetUsers,
  listConsumables,
  type WorksheetItemPatch,
  type WorksheetListItem,
  type WorksheetUpdate,
} from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import {
  useWorksheetDrawer,
  worksheetPageKey,
} from '@/hooks/use-worksheet-drawer'
import { useLabCalendar } from '@/hooks/use-lab-calendar'
import { useSlaForSubjects } from '@/services/sla-subjects'
import { worksheetItemSlaSubjects } from '@/lib/worksheet-sla-subjects'
import { endoItemsInBenchOrder } from '@/lib/endo-worksheet'
import {
  allowedCartridges,
  endoCtxFor,
  endoRowsFor,
} from '@/lib/endo-worksheet-2ml'
import { parseWorksheetNotes, withNotesText } from '@/lib/worksheet-notes'
import { worksheetKind } from '@/lib/worksheet-kind'
import AddSamplesModal from '@/components/hplc/AddSamplesModal'
import { BenchRunLog } from '@/components/hplc/BenchRunLog'
import { EndoWorksheetView } from '@/components/hplc/EndoWorksheetView'
import {
  CompleteWorksheetButton,
  WorksheetApplyBar,
} from '@/components/hplc/WorksheetDrawer'
import { EndoBoxHead, type EndoBoxProps } from './EndoBox'
import { EndoRunHeader } from './EndoRunHeader'
import { EndoSampleDilutionBox } from './EndoSampleDilutionBox'

const FIVE_MINUTES = 5 * 60 * 1000

/**
 * The endotoxin worksheet as a page (#hplc-analysis/worksheet?id=N, spec
 * 2026-10-10 6.1): Dennis's run log as a left rail, then the run and its
 * numbered boxes. Reads GET /worksheets/{id}, the only read that carries the
 * worksheet's endo method. Only all-endo worksheets get the page in this
 * release; any other id offers the flyout.
 */
export function EndoWorksheetPage() {
  const worksheetId = useUIStore(state => state.worksheetPageId)
  const {
    data: worksheet,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: worksheetPageKey(worksheetId ?? 0),
    queryFn: () => getWorksheet(worksheetId ?? 0),
    enabled: worksheetId != null,
  })

  if (worksheetId == null) return <PageNotice>No worksheet picked.</PageNotice>
  if (isLoading)
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-7 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  if (isError || !worksheet)
    return (
      <PageNotice>
        Could not load worksheet {worksheetId}.
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Retry
        </Button>
      </PageNotice>
    )
  if (worksheetKind(worksheet.items) !== 'endo')
    return (
      <PageNotice>
        WS-{worksheet.id} is not an endotoxin worksheet; only those have a page
        for now.
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            useUIStore.getState().openWorksheetDrawer(worksheet.id)
          }
        >
          Open in flyout
        </Button>
      </PageNotice>
    )
  // Keyed: the title draft and the Add samples dialog never carry over when
  // the run log switches worksheets.
  return <EndoWorksheetPageBody key={worksheet.id} worksheet={worksheet} />
}

function PageNotice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
      {children}
    </p>
  )
}

function EndoWorksheetPageBody({
  worksheet,
}: {
  worksheet: WorksheetListItem
}) {
  const id = worksheet.id
  const isCompleted = worksheet.status === 'completed'
  const drawer = useWorksheetDrawer()
  const [addSamplesOpen, setAddSamplesOpen] = useState(false)
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
  const { data: methods = [] } = useQuery({
    queryKey: ['hplc-methods'],
    queryFn: getMethods,
    staleTime: FIVE_MINUTES,
  })
  // The allowed list when no method resolves (spec 4.3): every active endo cartridge.
  const { data: catalog = [] } = useQuery({
    queryKey: ['consumables', 'endo_cartridge'],
    queryFn: () => listConsumables({ kind: 'endo_cartridge' }),
    staleTime: FIVE_MINUTES,
  })
  const { calendar } = useLabCalendar()
  const { byKey } = useSlaForSubjects(
    worksheetItemSlaSubjects(
      worksheet.items,
      isCompleted ? (worksheet.completed_at ?? null) : null
    )
  )

  // Box 1's order (due date, then priority), worked out as the table does, so
  // Boxes 2 and 3 number their rows as Box 1 does.
  const ordered = endoItemsInBenchOrder(
    worksheet.items,
    new Map(
      worksheet.items.map(it => [
        it.id,
        byKey.get(String(it.id))?.status.due_at ?? null,
      ])
    ),
    calendar
  )
  const cartridges = allowedCartridges(worksheet, catalog)
  const ctx = endoCtxFor(worksheet, catalog)
  const rows = endoRowsFor(ordered, worksheet, catalog)
  const boxProps: EndoBoxProps = {
    worksheet,
    rows,
    ctx,
    cartridges,
    isCompleted,
    onUpdateItem: updateItem,
  }
  const { userNotes } = parseWorksheetNotes(worksheet.notes ?? '')

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

  // Resolves to the server's refusal text (null once saved) so a box can
  // show it on the row; the mutation's onError still rolls back and toasts.
  // Never rejects, so Box 1 can ignore what it returns.
  function updateItem(
    itemId: number,
    data: WorksheetItemPatch
  ): Promise<string | null> {
    return drawer.updateItemMutation
      .mutateAsync({ worksheetId: id, itemId, data })
      .then(
        () => null,
        (err: unknown) =>
          err instanceof Error ? err.message : 'Update item failed'
      )
  }

  function applyToAll(methodId: number, instrumentId: number) {
    drawer.applyMethodInstrumentMutation.mutate(
      {
        worksheetId: id,
        data: { method_id: methodId, instrument_id: instrumentId },
      },
      {
        onSuccess: res => {
          const skipped = [
            res.skipped_state.length
              ? `${res.skipped_state.length} locked`
              : '',
            res.skipped_uncovered.length
              ? `${res.skipped_uncovered.length} not covered by this method`
              : '',
          ].filter(Boolean)
          toast.success(
            `Stamped ${res.stamped} analyses on ${res.items_updated} items${
              skipped.length ? `; ${skipped.join(', ')}` : ''
            }`
          )
        },
      }
    )
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-muted/30">
      <BenchRunLog
        kind="endo"
        label="Endotoxin"
        tickLabels={['Made', 'MCS']}
        activeId={id}
        users={users}
        onSelect={next => useUIStore.getState().navigateToWorksheet(next)}
      />
      {/* Boxes 2 and 3 mount as children of EndoWorksheetView (after Box 1)
          on 2 mL runs, each with boxProps. */}
      <EndoWorksheetView
        worksheet={worksheet}
        users={users}
        userNotes={userNotes}
        isCompleted={isCompleted}
        otherWorksheets={drawer.openWorksheets.filter(ws => ws.id !== id)}
        applyBar={
          !isCompleted && (
            <WorksheetApplyBar
              key={id}
              activeMethods={methods.filter(m => m.active)}
              instruments={instruments}
              isPending={drawer.applyMethodInstrumentMutation.isPending}
              onApply={applyToAll}
            />
          )
        }
        completeAction={
          <CompleteWorksheetButton
            onConfirm={() => drawer.completeMutation.mutate(id)}
          />
        }
        onAddSamples={() => setAddSamplesOpen(true)}
        onUpdate={update}
        onRemove={itemId =>
          drawer.removeMutation.mutate({ worksheetId: id, itemId })
        }
        onReassign={(itemId, targetWorksheetId) =>
          drawer.reassignMutation.mutate({
            worksheetId: id,
            itemId,
            targetWorksheetId,
          })
        }
        onUpdateItem={updateItem}
        onTickAll={data =>
          drawer.bulkTicksMutation.mutate({ worksheetId: id, data })
        }
        prepModel={worksheet.endo_prep === '2ml' ? '2ml' : 'stock'}
        twoMl={{ rows, ctx, cartridges }}
        heading={
          <EndoBoxHead
            n={1}
            title="Sample intake: reconstitute each vial"
            sub="What came in, when it is due, and the water that goes into each vial. Tick Made and MCS as you go."
          />
        }
        runHeader={
          <EndoRunHeader
            worksheet={worksheet}
            cartridges={cartridges}
            isCompleted={isCompleted}
            onUpdate={update}
          />
        }
      >
        {worksheet.endo_prep === '2ml' && (
          <>
            <EndoSampleDilutionBox {...boxProps} />
          </>
        )}
      </EndoWorksheetView>
      <AddSamplesModal
        open={addSamplesOpen}
        onOpenChange={setAddSamplesOpen}
        worksheetId={id}
        existingItems={worksheet.items}
        onAdd={data => drawer.addItemMutation.mutate({ worksheetId: id, data })}
      />
    </div>
  )
}

export default EndoWorksheetPage
