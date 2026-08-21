import { useState, useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ClipboardList } from 'lucide-react'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
// Badge removed — worksheet selector uses Select instead of Tabs
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useUIStore } from '@/store/ui-store'
import { useAuthStore } from '@/store/auth-store'
import { useWorksheetDrawer } from '@/hooks/use-worksheet-drawer'
import { getWorksheetUsers, getInstruments, getMethods } from '@/lib/api'
import type { HplcMethod, Instrument } from '@/lib/api'
import { prepStartedKey } from '@/lib/worksheet-scope-key'
import WorksheetDrawerHeader from './WorksheetDrawerHeader'
import WorksheetDrawerItems from './WorksheetDrawerItems'
import AddSamplesModal from './AddSamplesModal'

export function WorksheetDrawer() {
  const drawerOpen = useUIStore(state => state.worksheetDrawerOpen)
  const closeDrawer = useUIStore(state => state.closeWorksheetDrawer)
  const setActiveId = useUIStore(state => state.setActiveWorksheetId)
  const activeWorksheetId = useUIStore(state => state.activeWorksheetId)
  const currentUserEmail = useAuthStore(state => state.user?.email ?? '')

  const [analystFilter, setAnalystFilter] = useState(currentUserEmail)

  const {
    openWorksheets: allOpenWorksheets,
    activeWorksheet,
    isLoading,
    isError,
    refetch,
    updateMutation,
    removeMutation,
    completeMutation,
    reassignMutation,
    updateItemMutation,
    applyMethodInstrumentMutation,
    reorderMutation,
    addItemMutation,
  } = useWorksheetDrawer()

  // Filter worksheets by analyst
  const openWorksheets = analystFilter === 'all'
    ? allOpenWorksheets
    : allOpenWorksheets.filter(ws => ws.assigned_analyst_email === analystFilter)

  // Build unique analyst list from all open worksheets
  const analystOptions = (() => {
    const emails = new Set(
      allOpenWorksheets.map(ws => ws.assigned_analyst_email).filter(Boolean) as string[],
    )
    return Array.from(emails).sort()
  })()

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

  const { data: methods = [] } = useQuery({
    queryKey: ['hplc-methods'],
    queryFn: getMethods,
    staleTime: 5 * 60 * 1000,
  })

  // Methods available to the apply bar (run context). Instrument options
  // are computed per-selection inside WorksheetApplyBar, scoped to the
  // chosen method's linked instruments intersected with active instruments
  // — deliberately NOT sorted by worksheet department (spec §4.6 nicety
  // dropped; the list is already method-scoped to 1-3 rows, see task-6
  // brief).
  const activeMethods = useMemo(() => methods.filter(m => m.active), [methods])

  // Auto-select first worksheet when drawer opens or filter changes
  useEffect(() => {
    if (!drawerOpen || openWorksheets.length === 0) return
    const activeStillVisible = openWorksheets.some(ws => ws.id === activeWorksheetId)
    if (!activeStillVisible) {
      setActiveId(openWorksheets[0]!.id)
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

  function handleApplyToAll(methodId: number, instrumentId: number) {
    if (!activeWorksheet) return
    applyMethodInstrumentMutation.mutate(
      {
        worksheetId: activeWorksheet.id,
        data: { method_id: methodId, instrument_id: instrumentId },
      },
      {
        onSuccess: res => {
          let message = `Stamped ${res.stamped} analyses on ${res.items_updated} items`
          if (res.skipped_state.length) {
            message += ` — ${res.skipped_state.length} locked`
          }
          if (res.skipped_uncovered.length) {
            message += `, ${res.skipped_uncovered.length} not covered by this method`
          }
          toast.success(message)
        },
      }
    )
  }

  return (
    <>
      {/* Sheet drawer */}
      <Sheet open={drawerOpen} onOpenChange={open => { if (!open) closeDrawer() }}>
        <SheetContent side="right" className="w-[1100px] sm:max-w-[1100px] p-0 flex flex-col">
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

          {/* Analyst filter + worksheet selector */}
          {!isLoading && !isError && allOpenWorksheets.length >= 1 && (
            <div className="border-b px-4 py-2 flex items-center gap-2">
              <Select value={analystFilter} onValueChange={setAnalystFilter}>
                <SelectTrigger className="w-48 shrink-0">
                  <SelectValue placeholder="All analysts" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All analysts</SelectItem>
                  {analystOptions.map(email => (
                    <SelectItem key={email} value={email}>
                      {email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {openWorksheets.length >= 2 && (
                <Select
                  value={String(activeWorksheetId)}
                  onValueChange={v => setActiveId(Number(v))}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {openWorksheets.map(ws => (
                      <SelectItem key={ws.id} value={String(ws.id)}>
                        {ws.title}
                        <span className="ml-2 text-muted-foreground text-xs">
                          ({ws.item_count} items)
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {/* Active worksheet content */}
          {!isLoading && !isError && activeWorksheet && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
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

              {/* Apply bar — run context (method + instrument) for "Apply to
                  all". Keyed on the worksheet id: remounting on switch is
                  how the armed selections get cleared (React's recommended
                  "reset state on prop change" idiom — an effect calling
                  setState here would trip react-hooks/set-state-in-effect
                  for no benefit) so a method/instrument armed for worksheet
                  A can't get one-click applied to worksheet B. Stays sticky
                  across a successful apply within the SAME worksheet
                  (repeat-apply convenience) since the key doesn't change. */}
              {!isCompleted && (
                <WorksheetApplyBar
                  key={activeWorksheet.id}
                  activeMethods={activeMethods}
                  instruments={instruments}
                  isPending={applyMethodInstrumentMutation.isPending}
                  onApply={handleApplyToAll}
                />
              )}

              {/* Items section */}
              <WorksheetDrawerItems
                items={activeWorksheet.items}
                worksheetId={activeWorksheet.id}
                openWorksheets={openWorksheets}
                isCompleted={!!isCompleted}
                worksheetCompletedAtProp={activeWorksheet.completed_at}
                prepStartedItems={prepStartedItems}
                onRemove={(itemId) =>
                  removeMutation.mutate({
                    worksheetId: activeWorksheet.id,
                    itemId,
                  })
                }
                onReassign={(itemId, targetId) =>
                  reassignMutation.mutate({
                    worksheetId: activeWorksheet.id,
                    itemId,
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
                  parsed[
                    `prep_started:${prepStartedKey(item.sampleId, item.departmentId, item.serviceGroupId)}`
                  ] = true
                  updateMutation.mutate({
                    worksheetId: activeWorksheet.id,
                    data: { notes: JSON.stringify(parsed) },
                  })
                  // Navigate to new-analysis with pre-fill
                  useUIStore.getState().startPrepFromWorksheet({
                    sampleId: item.sampleId,
                    peptideId: item.peptideId,
                    method: null,
                    instrumentId: item.instrumentUid
                      ? instruments.find(i => i.senaite_uid === item.instrumentUid)?.id ?? null
                      : null,
                    limsSubSamplePk: item.limsSubSamplePk ?? null,
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
            </div>
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

interface WorksheetApplyBarProps {
  activeMethods: HplcMethod[]
  instruments: Instrument[]
  isPending: boolean
  onApply: (methodId: number, instrumentId: number) => void
}

/** Method + instrument "run context" picker for the worksheet drawer's
 *  "Apply to all". Split out from WorksheetDrawer so its armed selections
 *  reset for free by remounting on `key={worksheet.id}` — see the comment
 *  at its call site. */
function WorksheetApplyBar({
  activeMethods,
  instruments,
  isPending,
  onApply,
}: WorksheetApplyBarProps) {
  const [methodId, setMethodId] = useState<number | null>(null)
  const [instrumentId, setInstrumentId] = useState<number | null>(null)
  const selectedMethod = activeMethods.find(m => m.id === methodId) ?? null
  const instrumentOptions = useMemo(() => {
    if (!selectedMethod) return []
    const ids = new Set(selectedMethod.instrument_ids)
    return instruments.filter(i => i.active && ids.has(i.id))
  }, [selectedMethod, instruments])

  return (
    <div className="px-4 py-2 border-b flex items-center gap-2">
      <span className="text-xs font-semibold text-muted-foreground shrink-0">
        Run context
      </span>
      <Select
        value={methodId != null ? String(methodId) : ''}
        onValueChange={value => {
          setMethodId(Number(value))
          setInstrumentId(null)
        }}
      >
        <SelectTrigger size="sm" aria-label="Method" className="w-48 h-8 text-xs">
          <SelectValue placeholder="Method…" />
        </SelectTrigger>
        <SelectContent>
          {activeMethods.map(m => (
            <SelectItem key={m.id} value={String(m.id)}>
              {m.code ?? m.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={instrumentId != null ? String(instrumentId) : ''}
        onValueChange={value => setInstrumentId(Number(value))}
        disabled={!selectedMethod}
      >
        <SelectTrigger size="sm" aria-label="Instrument" className="w-40 h-8 text-xs">
          <SelectValue placeholder="Instrument…" />
        </SelectTrigger>
        <SelectContent>
          {instrumentOptions.map(inst => (
            <SelectItem key={inst.id} value={String(inst.id)}>
              {inst.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="sm"
        disabled={methodId == null || instrumentId == null || isPending}
        onClick={() => {
          if (methodId != null && instrumentId != null) onApply(methodId, instrumentId)
        }}
      >
        Apply to all
      </Button>
    </div>
  )
}

export default WorksheetDrawer
