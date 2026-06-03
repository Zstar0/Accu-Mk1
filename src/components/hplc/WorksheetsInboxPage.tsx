import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DndContext, DragOverlay, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core'
import { useEffect, useState } from 'react'
import { HelpCircle, Inbox, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { InboxVialCard, type DragData } from '@/components/hplc/InboxVialCard'
import { WorksheetDropPanel } from '@/components/hplc/WorksheetDropPanel'
import {
  useInboxSamples,
  usePriorityMutation,
} from '@/hooks/use-inbox-samples'
import {
  getWorksheetUsers,
  getInboxSamples,
  listWorksheets,
  addGroupToWorksheet,
  createWorksheetFromDrop,
  updateWorksheet,
  deleteWorksheet,
  removeWorksheetItem,
  type InboxPriority,
  type InboxRole,
} from '@/lib/api'

// localStorage keys for filter persistence (per the spec UI section)
const STORAGE_ROLE_KEY = 'accu_mk1_worksheet_inbox_role'
const STORAGE_SHOW_XTRA_KEY = 'accu_mk1_worksheet_inbox_show_xtra'
const STORAGE_HIDE_TEST_KEY = 'accu_mk1_worksheet_inbox_hide_test_orders'

function loadStoredRole(): InboxRole {
  const v = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_ROLE_KEY) : null
  return v === 'microbiology' ? 'microbiology' : 'hplc'
}

function loadStoredShowXtra(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(STORAGE_SHOW_XTRA_KEY) === 'true'
}

function loadStoredHideTestOrders(): boolean {
  // Default to true (the production-safe behavior). Persisted so a tester who
  // unchecks it once doesn't get reset every page load.
  if (typeof window === 'undefined') return true
  const v = window.localStorage.getItem(STORAGE_HIDE_TEST_KEY)
  return v === null ? true : v === 'true'
}

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

// ─── Page ─────────────────────────────────────────────────────────────────────
//
// Vial-flat inbox: one card per vial (parent or sub-sample). Server-side
// sorting groups same-family vials adjacently (parent first, then subs by
// vial_sequence); the only client-side sort is the priority pass below.

export default function WorksheetsInboxPage() {
  const queryClient = useQueryClient()
  const [hideTestOrders, setHideTestOrders] = useState<boolean>(loadStoredHideTestOrders)
  const [hidePrepped, setHidePrepped] = useState(true)
  const [role, setRole] = useState<InboxRole>(loadStoredRole)
  const [showXtra, setShowXtra] = useState<boolean>(loadStoredShowXtra)
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Persist filter selections so the tech's last filter sticks across sessions
  useEffect(() => {
    window.localStorage.setItem(STORAGE_ROLE_KEY, role)
  }, [role])
  useEffect(() => {
    window.localStorage.setItem(STORAGE_SHOW_XTRA_KEY, String(showXtra))
  }, [showXtra])
  useEffect(() => {
    window.localStorage.setItem(STORAGE_HIDE_TEST_KEY, String(hideTestOrders))
  }, [hideTestOrders])

  const {
    data: inboxData,
    isLoading,
    isError,
    error,
    refetch,
  } = useInboxSamples({ hideTestOrders, hidePrepped, role, showXtra })

  const handleForceRefresh = async () => {
    setIsRefreshing(true)
    try {
      await getInboxSamples({
        hideTestOrders,
        forceRefresh: true,
        hidePrepped,
        role,
        showXtra,
      })
      queryClient.invalidateQueries({ queryKey: ['inbox-samples'] })
    } finally {
      setIsRefreshing(false)
    }
  }

  const priorityMutation = usePriorityMutation()


  const { data: users = [] } = useQuery({
    queryKey: ['worksheet-users'],
    queryFn: getWorksheetUsers,
    staleTime: 5 * 60 * 1000,
  })

  const { data: worksheets = [], isLoading: worksheetsLoading } = useQuery({
    queryKey: ['worksheets-list'],
    queryFn: () => listWorksheets('open'),
    refetchInterval: 30_000,
  })

  const [activeDrag, setActiveDrag] = useState<DragData | null>(null)
  const [pendingDropKeys, setPendingDropKeys] = useState<Set<string>>(new Set())

  const vials = inboxData?.items ?? []
  const total = inboxData?.total ?? 0
  const visibleVials = vials
    .filter(v => !pendingDropKeys.has(`${v.uid}::${v.analyses[0]?.group_id ?? 0}`))
    // Priority pass on top of the server's family-sort. Stable: same-parent
    // vials stay adjacent because the secondary sort key is preserved.
    .slice()
    .sort((a, b) => {
      const priorityOrder: Record<string, number> = { expedited: 0, high: 1, normal: 2 }
      const pa = priorityOrder[a.priority] ?? 2
      const pb = priorityOrder[b.priority] ?? 2
      if (pa !== pb) return pa - pb
      // Within same priority, keep parents + their subs adjacent via
      // (parent_sample_id, is_parent first, vial_sequence) — same as backend.
      if (a.parent_sample_id !== b.parent_sample_id) {
        return a.parent_sample_id.localeCompare(b.parent_sample_id)
      }
      if (a.is_parent !== b.is_parent) return a.is_parent ? -1 : 1
      return a.vial_sequence - b.vial_sequence
    })

  function handlePriorityChange(sampleUid: string, priority: InboxPriority) {
    priorityMutation.mutate({ sampleUid, priority })
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
          date_received: dragData.dateReceived,
          analyses: dragData.analyses,
        })
        toast.success(`Created "${result.title}"`)
      } else if (dropId.startsWith('worksheet-')) {
        const worksheetId = Number(dropId.replace('worksheet-', ''))
        await addGroupToWorksheet(worksheetId, {
          sample_uid: dragData.sampleUid,
          sample_id: dragData.sampleId,
          service_group_id: dragData.groupId,
          date_received: dragData.dateReceived,
          analyses: dragData.analyses,
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
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
                  {!isLoading && !isError && (
                    <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-sm font-medium text-muted-foreground">
                      {total} vial{total === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Drag vials to worksheets on the right
                </p>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <Checkbox
                    checked={hideTestOrders}
                    onCheckedChange={v => setHideTestOrders(v === true)}
                  />
                  <span className="text-sm text-muted-foreground">Hide test orders</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <Checkbox
                    checked={hidePrepped}
                    onCheckedChange={v => setHidePrepped(v === true)}
                  />
                  <span className="text-sm text-muted-foreground">Hide prepped</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <Checkbox
                    checked={showXtra}
                    onCheckedChange={v => setShowXtra(v === true)}
                  />
                  <span className="text-sm text-muted-foreground">Show XTRA</span>
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleForceRefresh}
                  disabled={isRefreshing}
                  className="gap-1.5 text-muted-foreground"
                  title="Force refresh from SENAITE (cached for 30 minutes)"
                >
                  <RefreshCw className={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
                  <span className="text-xs">Refresh</span>
                </Button>
                {/* Worksheets SOP — served from public/guides/ via Vite. Path
                    matches the file the build script mirrors there. */}
                <a
                  href="/guides/lab-tech-worksheets-variance.html"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
                  title="Open the lab-tech worksheets &amp; variance SOP in a new tab"
                >
                  <HelpCircle className="size-3.5" aria-hidden="true" />
                  Worksheets SOP
                </a>
              </div>
            </div>

            {/* Bench filter chips */}
            <div className="mb-6 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setRole('hplc')}
                className={cn(
                  'inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium transition-colors',
                  role === 'hplc'
                    ? 'bg-sky-500/15 text-sky-700 border-sky-500/40 dark:text-sky-300'
                    : 'bg-transparent text-muted-foreground border-border hover:bg-muted/40',
                )}
              >
                HPLC
              </button>
              <button
                type="button"
                onClick={() => setRole('microbiology')}
                className={cn(
                  'inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium transition-colors',
                  role === 'microbiology'
                    ? 'bg-violet-500/15 text-violet-700 border-violet-500/40 dark:text-violet-300'
                    : 'bg-transparent text-muted-foreground border-border hover:bg-muted/40',
                )}
              >
                Microbiology
              </button>
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
            {!isLoading && !isError && visibleVials.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-3 rounded-md border py-16 text-center">
                <Inbox className="size-12 text-muted-foreground/50" />
                <p className="text-sm font-medium text-muted-foreground">
                  No {role === 'hplc' ? 'HPLC' : 'Microbiology'} vials waiting
                </p>
                <p className="text-xs text-muted-foreground/60">
                  {role === 'hplc'
                    ? 'Switch to Microbiology to see those vials.'
                    : 'Switch to HPLC to see those vials.'}
                </p>
              </div>
            )}

            {/* Cards */}
            {!isLoading && !isError && visibleVials.length > 0 && (
              <div className="space-y-2">
                {visibleVials.map((vial, idx) => {
                  const prev = idx > 0 ? visibleVials[idx - 1] : null
                  const groupedWithPrevious =
                    prev !== null && prev.parent_sample_id === vial.parent_sample_id
                  return (
                    <InboxVialCard
                      key={vial.uid}
                      vial={vial}
                      groupedWithPrevious={groupedWithPrevious}
                      onPriorityChange={handlePriorityChange}
                    />
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right — worksheet drop panel (scrollable) */}
        <div className="w-96 shrink-0 h-full overflow-y-auto">
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
            onDelete={async (id) => {
              try {
                await deleteWorksheet(id)
                toast.success('Worksheet deleted — items returned to inbox')
                setPendingDropKeys(new Set())
                queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
                queryClient.invalidateQueries({ queryKey: ['inbox-samples'] })
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Delete failed')
              }
            }}
            onRemoveItem={async (worksheetId, sampleUid, serviceGroupId) => {
              try {
                await removeWorksheetItem(worksheetId, sampleUid, serviceGroupId)
                toast.success('Item returned to inbox')
                setPendingDropKeys(new Set())
                queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
                queryClient.invalidateQueries({ queryKey: ['inbox-samples'] })
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Remove failed')
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
