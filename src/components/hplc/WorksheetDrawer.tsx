import { useState, useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ClipboardList } from 'lucide-react'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useUIStore } from '@/store/ui-store'
import { useWorksheetDrawer } from '@/hooks/use-worksheet-drawer'
import { getWorksheetUsers, getInstruments } from '@/lib/api'
import WorksheetDrawerHeader from './WorksheetDrawerHeader'
import WorksheetDrawerItems from './WorksheetDrawerItems'
import AddSamplesModal from './AddSamplesModal'

export function WorksheetDrawer() {
  const drawerOpen = useUIStore(state => state.worksheetDrawerOpen)
  const closeDrawer = useUIStore(state => state.closeWorksheetDrawer)
  const setActiveId = useUIStore(state => state.setActiveWorksheetId)
  const activeWorksheetId = useUIStore(state => state.activeWorksheetId)

  const {
    openWorksheets,
    activeWorksheet,
    totalOpenItems,
    isLoading,
    isError,
    refetch,
    updateMutation,
    removeMutation,
    completeMutation,
    reassignMutation,
    updateItemMutation,
    reorderMutation,
    addItemMutation,
  } = useWorksheetDrawer()

  const { data: users = [] } = useQuery({
    queryKey: ['worksheet-users'],
    queryFn: getWorksheetUsers,
    staleTime: 5 * 60 * 1000,
  })

  const { data: instruments = [] } = useQuery({
    queryKey: ['instruments'],
    queryFn: getInstruments,
    staleTime: 5 * 60 * 1000,
  })

  // Auto-select first open worksheet when drawer opens with no active selection
  useEffect(() => {
    const first = openWorksheets[0]
    if (drawerOpen && !activeWorksheetId && first) {
      setActiveId(first.id)
    }
  }, [drawerOpen, activeWorksheetId, openWorksheets, setActiveId])

  const [addSamplesOpen, setAddSamplesOpen] = useState(false)

  const isCompleted = activeWorksheet?.status === 'completed'

  // Parse notes JSON: separate user text from prep_started metadata
  const { userNotes, prepStartedItems } = useMemo(() => {
    const raw = activeWorksheet?.notes ?? ''
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Plain text notes (not JSON) — treat as user text
      return { userNotes: raw, prepStartedItems: new Set<string>() }
    }
    const set = new Set<string>()
    for (const key of Object.keys(parsed)) {
      if (key.startsWith('prep_started:')) {
        set.add(key.replace('prep_started:', ''))
      }
    }
    const text = typeof parsed.text === 'string' ? parsed.text : ''
    return { userNotes: text, prepStartedItems: set }
  }, [activeWorksheet?.notes])

  return (
    <>
      {/* FAB button — only visible when drawer is closed */}
      {!drawerOpen && (
        <button
          onClick={() => useUIStore.getState().openWorksheetDrawer()}
          className="fixed bottom-8 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors"
          aria-label="Open worksheet"
        >
          <ClipboardList className="h-5 w-5" />
          {totalOpenItems > 0 && (
            <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-[10px] text-destructive-foreground font-semibold">
              {totalOpenItems > 99 ? '99+' : totalOpenItems}
            </span>
          )}
        </button>
      )}

      {/* Sheet drawer */}
      <Sheet open={drawerOpen} onOpenChange={open => { if (!open) closeDrawer() }}>
        <SheetContent side="right" className="w-[960px] sm:max-w-[960px] p-0 flex flex-col">
          {/* Loading state */}
          {isLoading && (
            <div className="p-4 space-y-3">
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}

          {/* Error state */}
          {isError && (
            <div className="p-4">
              <Alert variant="destructive">
                <AlertTitle>Could not load worksheet</AlertTitle>
                <AlertDescription>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => refetch()}
                  >
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            </div>
          )}

          {/* Worksheet tabs — only when 2+ open worksheets */}
          {!isLoading && !isError && openWorksheets.length >= 2 && (
            <Tabs
              value={String(activeWorksheetId)}
              onValueChange={v => setActiveId(Number(v))}
              className="border-b"
            >
              <TabsList className="w-full justify-start overflow-x-auto">
                {openWorksheets.map(ws => (
                  <TabsTrigger
                    key={ws.id}
                    value={String(ws.id)}
                    className="max-w-[160px] truncate"
                  >
                    {ws.title.length > 20 ? ws.title.slice(0, 20) + '...' : ws.title}
                    <Badge variant="secondary" className="ml-1 text-[10px]">
                      {ws.item_count}
                    </Badge>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}

          {/* Active worksheet content */}
          {!isLoading && !isError && activeWorksheet && (
            <>
              {/* Header */}
              <WorksheetDrawerHeader
                worksheet={activeWorksheet}
                userNotes={userNotes}
                users={users}
                onUpdate={data => {
                  // If updating notes text, merge with existing metadata
                  if (data.notes !== undefined) {
                    const raw = activeWorksheet.notes ?? ''
                    let parsed: Record<string, unknown> = {}
                    try {
                      parsed = JSON.parse(raw)
                    } catch {
                      parsed = {}
                    }
                    parsed.text = data.notes
                    data = { ...data, notes: JSON.stringify(parsed) }
                  }
                  updateMutation.mutate({ worksheetId: activeWorksheet.id, data })
                }}
                isCompleted={!!isCompleted}
              />

              {/* Action row */}
              {!isCompleted ? (
                <div className="px-4 py-2 border-b flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setAddSamplesOpen(true)}
                  >
                    Add Samples
                  </Button>
                  <div className="flex-1" />
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive" size="sm">
                        Complete Worksheet
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Complete this worksheet?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This worksheet will be marked as completed and removed from the active
                          queue. This cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Keep Worksheet</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => completeMutation.mutate(activeWorksheet.id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Complete Worksheet
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ) : (
                <div className="px-4 py-2 border-b">
                  <span className="text-xs text-muted-foreground">
                    View only — worksheet is completed
                  </span>
                </div>
              )}

              {/* Items section */}
              <WorksheetDrawerItems
                items={activeWorksheet.items}
                worksheetId={activeWorksheet.id}
                openWorksheets={openWorksheets}
                isCompleted={!!isCompleted}
                prepStartedItems={prepStartedItems}
                onRemove={(uid, gid) =>
                  removeMutation.mutate({
                    worksheetId: activeWorksheet.id,
                    sampleUid: uid,
                    serviceGroupId: gid,
                  })
                }
                onReassign={(uid, gid, targetId) =>
                  reassignMutation.mutate({
                    worksheetId: activeWorksheet.id,
                    sampleUid: uid,
                    serviceGroupId: gid,
                    targetWorksheetId: targetId,
                  })
                }
                onStartPrep={item => {
                  // Persist prep_started flag to worksheet notes JSON
                  const currentNotes = activeWorksheet.notes ?? '{}'
                  let parsed: Record<string, unknown> = {}
                  try {
                    parsed = JSON.parse(currentNotes)
                  } catch {
                    parsed = { text: currentNotes }
                  }
                  parsed[`prep_started:${item.sampleId}-${item.serviceGroupId}`] = true
                  updateMutation.mutate({
                    worksheetId: activeWorksheet.id,
                    data: { notes: JSON.stringify(parsed) },
                  })
                  // Navigate to new-analysis with pre-fill
                  useUIStore.getState().startPrepFromWorksheet({
                    sampleId: item.sampleId,
                    peptideId: item.peptideId,
                    method: null,
                  })
                }}
                instruments={instruments}
                onUpdateItem={(itemId, data) =>
                  updateItemMutation.mutate({
                    worksheetId: activeWorksheet.id,
                    itemId,
                    data,
                  })
                }
                onReorder={itemIds =>
                  reorderMutation.mutate({
                    worksheetId: activeWorksheet.id,
                    itemIds,
                  })
                }
              />

              {/* Add Samples modal */}
              <AddSamplesModal
                open={addSamplesOpen}
                onOpenChange={setAddSamplesOpen}
                worksheetId={activeWorksheet.id}
                existingItems={activeWorksheet.items}
                onAdd={data =>
                  addItemMutation.mutate({ worksheetId: activeWorksheet.id, data })
                }
              />
            </>
          )}

          {/* No active worksheet fallback */}
          {!isLoading && !isError && !activeWorksheet && (
            <div className="flex flex-col items-center justify-center flex-1 p-8 text-center">
              <ClipboardList className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm font-semibold">No active worksheet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Open a worksheet from the inbox to get started.
              </p>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  )
}

export default WorksheetDrawer
