import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DndContext, DragOverlay, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core'
import { useState } from 'react'
import { Inbox, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { InboxServiceGroupCard, type DragData } from '@/components/hplc/InboxServiceGroupCard'
import { WorksheetDropPanel } from '@/components/hplc/WorksheetDropPanel'
import {
  useInboxSamples,
  usePriorityMutation,
  useBulkUpdateMutation,
} from '@/hooks/use-inbox-samples'
import {
  getWorksheetUsers,
  getInstruments,
  listWorksheets,
  addGroupToWorksheet,
  createWorksheetFromDrop,
  updateWorksheet,
  type InboxPriority,
  type InboxSampleItem,
  type InboxServiceGroupSection,
} from '@/lib/api'

// ─── Skeleton ────────────────────────────────────────────────────────────────

function CardSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-lg border p-4 animate-pulse">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-4 w-16 rounded bg-muted" />
            <div className="h-5 w-20 rounded bg-muted" />
            <div className="flex-1" />
            <div className="h-4 w-16 rounded bg-muted" />
            <div className="h-4 w-12 rounded bg-muted" />
          </div>
          <div className="space-y-2">
            <div className="h-3 w-48 rounded bg-muted" />
            <div className="h-3 w-36 rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Flatten samples → service group cards ───────────────────────────────────

interface FlatCard {
  sample: InboxSampleItem
  group: InboxServiceGroupSection
  key: string
}

function flattenToCards(samples: InboxSampleItem[]): FlatCard[] {
  const cards: FlatCard[] = []
  for (const sample of samples) {
    for (const group of sample.analyses_by_group) {
      cards.push({
        sample,
        group,
        key: `${sample.uid}::${group.group_id}`,
      })
    }
  }
  // Sort: expedited first, then high, then normal. Within same priority, by age (oldest first).
  const priorityOrder: Record<string, number> = { expedited: 0, high: 1, normal: 2 }
  cards.sort((a, b) => {
    const pa = priorityOrder[a.sample.priority] ?? 2
    const pb = priorityOrder[b.sample.priority] ?? 2
    if (pa !== pb) return pa - pb
    // Older samples first (earlier date_received)
    const da = a.sample.date_received ?? ''
    const db = b.sample.date_received ?? ''
    return da.localeCompare(db)
  })
  return cards
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WorksheetsInboxPage() {
  const queryClient = useQueryClient()
  const {
    data: inboxData,
    isLoading,
    isError,
    error,
    refetch,
  } = useInboxSamples()

  const priorityMutation = usePriorityMutation()
  const bulkUpdateMutation = useBulkUpdateMutation()

  const { data: users = [] } = useQuery({
    queryKey: ['worksheet-users'],
    queryFn: getWorksheetUsers,
    staleTime: 5 * 60 * 1000,
  })

  const { data: instrumentsRaw = [] } = useQuery({
    queryKey: ['instruments'],
    queryFn: getInstruments,
    staleTime: 5 * 60 * 1000,
  })

  const { data: worksheets = [], isLoading: worksheetsLoading } = useQuery({
    queryKey: ['worksheets-list'],
    queryFn: () => listWorksheets('open'),
    refetchInterval: 30_000,
  })

  const instruments = instrumentsRaw.map(inst => ({
    uid: inst.senaite_uid ?? String(inst.id),
    title: inst.name,
  }))

  const [activeDrag, setActiveDrag] = useState<DragData | null>(null)
  const [pendingDropKeys, setPendingDropKeys] = useState<Set<string>>(new Set())

  const samples = inboxData?.items ?? []
  const total = inboxData?.total ?? 0
  const cards = flattenToCards(samples).filter(c => !pendingDropKeys.has(c.key))

  function handlePriorityChange(sampleUid: string, priority: InboxPriority) {
    priorityMutation.mutate({ sampleUid, priority })
  }

  function handleGroupTechAssign(sampleUid: string, groupId: number, analystId: number) {
    bulkUpdateMutation.mutate({
      sample_uids: [sampleUid],
      service_group_id: groupId,
      analyst_id: analystId,
    })
  }

  function handleGroupInstrumentAssign(sampleUid: string, groupId: number, instrumentUid: string) {
    bulkUpdateMutation.mutate({
      sample_uids: [sampleUid],
      service_group_id: groupId,
      instrument_uid: instrumentUid,
    })
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveDrag(event.active.data.current as DragData)
    // Prevent body scroll during drag
    document.body.style.overflow = 'hidden'
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveDrag(null)
    document.body.style.overflow = ''
    const { over, active } = event
    if (!over) return

    const dragData = active.data.current as DragData
    const dropId = String(over.id)
    const cardKey = `${dragData.sampleUid}::${dragData.groupId}`

    // Optimistically hide the card immediately
    setPendingDropKeys(prev => new Set(prev).add(cardKey))

    try {
      if (dropId === 'new-worksheet') {
        const result = await createWorksheetFromDrop({
          sample_uid: dragData.sampleUid,
          sample_id: dragData.sampleId,
          service_group_id: dragData.groupId,
        })
        toast.success(`Created "${result.title}"`)
      } else if (dropId.startsWith('worksheet-')) {
        const worksheetId = Number(dropId.replace('worksheet-', ''))
        await addGroupToWorksheet(worksheetId, {
          sample_uid: dragData.sampleUid,
          sample_id: dragData.sampleId,
          service_group_id: dragData.groupId,
        })
        toast.success(`Added to worksheet`)
      }
      // Refresh both inbox and worksheets list
      queryClient.invalidateQueries({ queryKey: ['inbox-samples'] })
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
    } catch (err) {
      // Restore card on failure
      setPendingDropKeys(prev => {
        const next = new Set(prev)
        next.delete(cardKey)
        return next
      })
      toast.error(err instanceof Error ? err.message : 'Failed to assign to worksheet')
    }
  }

  return (
    <div className="h-[calc(100vh-4rem)] overflow-hidden">
    <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex h-full overflow-hidden">
        {/* Left — inbox cards (scrollable) */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-6">
            {/* Header */}
            <div className="flex items-start justify-between gap-4 mb-6">
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-2xl font-semibold tracking-tight">Received Samples</h1>
                  {!isLoading && !isError && (
                    <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-sm font-medium text-muted-foreground">
                      {cards.length} groups · {total} samples
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Drag analysis groups to worksheets on the right
                </p>
              </div>
            </div>

            {/* Loading state */}
            {isLoading && <CardSkeleton />}

            {/* Error state */}
            {isError && (
              <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-destructive/30 bg-destructive/5 py-12">
                <p className="text-sm text-destructive font-medium">
                  {error instanceof Error ? error.message : 'Failed to load received samples'}
                </p>
                <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
                  <RefreshCw className="size-4" />
                  Retry
                </Button>
              </div>
            )}

            {/* Empty state */}
            {!isLoading && !isError && cards.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-3 rounded-md border py-16 text-center">
                <Inbox className="size-12 text-muted-foreground/50" />
                <p className="text-sm font-medium text-muted-foreground">No received samples</p>
                <p className="text-xs text-muted-foreground/60">
                  Samples with status "Received" will appear here
                </p>
              </div>
            )}

            {/* Cards */}
            {!isLoading && !isError && cards.length > 0 && (
              <div className="space-y-2">
                {cards.map(card => (
                  <InboxServiceGroupCard
                    key={card.key}
                    sample={card.sample}
                    group={card.group}
                    users={users}
                    instruments={instruments}
                    onPriorityChange={handlePriorityChange}
                    onGroupTechAssign={handleGroupTechAssign}
                    onGroupInstrumentAssign={handleGroupInstrumentAssign}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right — worksheet drop panel (fixed, doesn't scroll with content) */}
        <div className="w-72 shrink-0 h-full overflow-hidden">
          <WorksheetDropPanel
            worksheets={worksheets}
            users={users}
            loading={worksheetsLoading}
            onRename={async (id, title) => {
              try {
                await updateWorksheet(id, { title })
                queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Rename failed')
              }
            }}
            onAssignTech={async (id, analystId) => {
              try {
                await updateWorksheet(id, { assigned_analyst: analystId })
                toast.success('Tech assigned to worksheet')
                queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Assignment failed')
              }
            }}
          />
        </div>
      </div>

      {/* Drag overlay — shows a ghost card while dragging */}
      <DragOverlay dropAnimation={null}>
        {activeDrag && (
          <div className="rounded-lg border bg-card shadow-xl px-3 py-2 opacity-90 w-48 pointer-events-none">
            <span className="font-mono text-xs font-medium">{activeDrag.sampleId}</span>
            <span className="mx-1.5 text-muted-foreground/50">·</span>
            <span className="text-xs">{activeDrag.groupName}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
    </div>
  )
}
