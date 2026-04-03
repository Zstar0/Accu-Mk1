import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ClipboardList, ListChecks, AlertTriangle, Clock } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { PriorityBadge } from '@/components/hplc/PriorityBadge'
import { AgingTimer } from '@/components/hplc/AgingTimer'
import { listWorksheets, type InboxPriority } from '@/lib/api'
import { useUIStore } from '@/store/ui-store'

// ─── Status badge classes (matching WorksheetDrawerHeader pattern) ─────────────

const STATUS_CLASSES: Record<string, string> = {
  open: 'bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300',
  completed:
    'bg-zinc-100 text-zinc-600 border border-zinc-200 dark:bg-zinc-900/30 dark:text-zinc-400',
  cancelled:
    'bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/30 dark:text-red-300',
}

// ─── Avg age formatter ────────────────────────────────────────────────────────

function formatAvgAge(ms: number): string {
  if (ms <= 0) return '—'
  const totalMinutes = Math.floor(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  return `${hours}h ${minutes}m`
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WorksheetsListPage() {
  const [statusFilter, setStatusFilter] = useState<string>('open')
  const [analystFilter, setAnalystFilter] = useState<string>('all')

  const { data: worksheets = [], isLoading, isError } = useQuery({
    queryKey: ['worksheets-list', statusFilter === 'all' ? undefined : statusFilter],
    queryFn: () => listWorksheets(statusFilter === 'all' ? undefined : statusFilter),
    refetchInterval: 30_000,
    staleTime: 0,
  })

  // ─── Derived data (React Compiler handles memoization) ──────────────────────

  const analysts = (() => {
    const emails = new Set(
      worksheets.map(w => w.assigned_analyst_email).filter(Boolean) as string[],
    )
    return Array.from(emails).sort()
  })()

  const filteredWorksheets =
    analystFilter === 'all'
      ? worksheets
      : worksheets.filter(w => w.assigned_analyst_email === analystFilter)

  // ─── KPI computations (from unfiltered worksheets) ───────────────────────────

  const openCount = worksheets.filter(w => w.status === 'open').length

  const itemsPending = worksheets
    .filter(w => w.status === 'open')
    .reduce((sum, w) => sum + w.item_count, 0)

  const itemsComplete = worksheets
    .filter(w => w.status === 'open')
    .flatMap(w => w.items)
    .filter(i => i.prep_status === 'complete').length

  const highPriorityCount = worksheets
    .flatMap(w => w.items)
    .filter(i => i.priority === 'high' || i.priority === 'expedited').length

  const avgAgeFormatted = (() => {
    const openWithItems = worksheets.filter(w => w.status === 'open' && w.items.length > 0)
    const now = Date.now()
    const ages = openWithItems.map(w => {
      const earliest = w.items
        .map(i => {
          const ts = i.date_received ?? i.added_at
          return ts ? new Date(ts).getTime() : now
        })
        .reduce((min, t) => Math.min(min, t), now)
      return now - earliest
    })
    const avgMs = ages.length > 0 ? ages.reduce((s, a) => s + a, 0) / ages.length : 0
    return formatAvgAge(avgMs)
  })()

  return (
    <div className="flex-1 p-6">
      <div className="flex flex-col gap-6">
        {/* Page header */}
        <div>
          <h1 className="text-2xl font-semibold">Worksheets</h1>
          <p className="text-sm text-muted-foreground">{filteredWorksheets.length} worksheets</p>
        </div>

        {/* KPI row */}
        {isLoading ? (
          <div className="grid grid-cols-5 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[72px] rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-5 gap-4">
            <Card className="py-0">
              <CardContent className="px-4 py-4">
                <div className="flex items-center gap-1.5">
                  <ClipboardList className="h-4 w-4 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">
                    Open Worksheets
                  </p>
                </div>
                <p className="text-xl font-semibold mt-1">{openCount}</p>
              </CardContent>
            </Card>

            <Card className="py-0">
              <CardContent className="px-4 py-4">
                <div className="flex items-center gap-1.5">
                  <ListChecks className="h-4 w-4 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">
                    Items Pending
                  </p>
                </div>
                <p className="text-xl font-semibold mt-1">{itemsPending}</p>
              </CardContent>
            </Card>

            <Card className="py-0">
              <CardContent className="px-4 py-4">
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">
                    High Priority
                  </p>
                </div>
                <p className="text-xl font-semibold mt-1">{highPriorityCount}</p>
              </CardContent>
            </Card>

            <Card className="py-0">
              <CardContent className="px-4 py-4">
                <div className="flex items-center gap-1.5">
                  <ListChecks className="h-4 w-4 text-emerald-500" />
                  <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">
                    Items Complete
                  </p>
                </div>
                <p className="text-xl font-semibold mt-1">{itemsComplete}</p>
              </CardContent>
            </Card>

            <Card className="py-0">
              <CardContent className="px-4 py-4">
                <div className="flex items-center gap-1.5">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">
                    Avg Age
                  </p>
                </div>
                <p className="text-xl font-semibold mt-1">{avgAgeFormatted}</p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Filter bar */}
        <div className="flex items-center gap-3">
          <Tabs value={statusFilter} onValueChange={setStatusFilter}>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="open">Open</TabsTrigger>
              <TabsTrigger value="completed">Completed</TabsTrigger>
            </TabsList>
          </Tabs>

          <Select value={analystFilter} onValueChange={setAnalystFilter}>
            <SelectTrigger className="w-52">
              <SelectValue placeholder="All analysts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All analysts</SelectItem>
              {analysts.map(email => (
                <SelectItem key={email} value={email}>
                  {email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Error state */}
        {isError && (
          <p className="text-destructive text-center py-8">
            Failed to load worksheets. Check your connection and try again.
          </p>
        )}

        {/* Table */}
        {!isError && (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Analyst</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead className="hidden xl:table-cell">Priority</TableHead>
                  <TableHead>Oldest Item</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={6}>
                        <Skeleton className="h-10 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : filteredWorksheets.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <div className="text-center py-12 text-muted-foreground">
                        {worksheets.length === 0 ? (
                          <>
                            <p className="font-medium">No worksheets yet</p>
                            <p className="text-sm mt-1">
                              Create a worksheet from the Inbox to get started.
                            </p>
                          </>
                        ) : (
                          <p>No worksheets match the current filters.</p>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredWorksheets.map(ws => {
                    // Compute priority breakdown
                    const priorityCounts: Record<string, number> = {}
                    for (const item of ws.items) {
                      priorityCounts[item.priority] = (priorityCounts[item.priority] ?? 0) + 1
                    }
                    const priorityOrder: InboxPriority[] = ['normal', 'high', 'expedited']
                    const activePriorities = priorityOrder.filter(
                      p => (priorityCounts[p] ?? 0) > 0,
                    )

                    // Find earliest date_received (or added_at as fallback)
                    const earliestAddedAt = ws.items
                      .map(i => i.date_received ?? i.added_at)
                      .filter(Boolean)
                      .sort()[0] ?? null

                    return (
                      <TableRow
                        key={ws.id}
                        className="cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => useUIStore.getState().openWorksheetDrawer(ws.id)}
                      >
                        <TableCell>
                          <span className="font-medium truncate max-w-[220px] inline-block">
                            {ws.title}
                          </span>
                        </TableCell>
                        <TableCell>
                          {ws.assigned_analyst_email ?? (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold capitalize ${STATUS_CLASSES[ws.status] ?? STATUS_CLASSES.open}`}
                          >
                            {ws.status}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="text-right tabular-nums">
                            {ws.items.filter(i => i.prep_status === 'complete').length}/{ws.item_count}
                          </span>
                        </TableCell>
                        <TableCell className="hidden xl:table-cell">
                          {activePriorities.length > 0 ? (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {activePriorities.map(p => (
                                <span key={p} className="flex items-center gap-0.5">
                                  <PriorityBadge priority={p} />
                                  <span className="text-xs text-muted-foreground">
                                    x{priorityCounts[p]}
                                  </span>
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {ws.completed_at ? (
                            <span className="text-sm text-muted-foreground">
                              {new Date(ws.completed_at).toLocaleDateString(undefined, {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                              })}
                            </span>
                          ) : earliestAddedAt ? (
                            <AgingTimer dateReceived={earliestAddedAt} compact />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}
