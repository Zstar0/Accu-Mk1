import { useState, useEffect, useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Loader2,
  RefreshCw,
  XCircle,
  FlaskConical,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { ReceiveWizard } from '@/components/intake/ReceiveWizard/ReceiveWizard'
import type { ParentInfo } from '@/components/intake/ReceiveWizard/useReceiveWizard'
import {
  getExplorerOrders,
  getSenaiteSamples,
  getSenaiteStatus,
  listSubSamples,
  type ExplorerOrder,
  type SenaiteSample,
} from '@/lib/api'
import {
  enrichOrderGroups,
  groupSamplesByOrder,
  type EnrichedOrderGroup,
  type OrderGroup,
} from '@/lib/inbox-orders'
import type { OrderSlaVerdict } from '@/lib/sla-resolution'
import { useOrderSlaStatuses } from '@/services/order-sla'
import { useSenaiteLookupMap } from '@/services/senaite-lookup-map'
import { OrderListRow } from '@/components/intake/OrderListRow'
import { OrderReceiveSession } from '@/components/intake/OrderReceiveSession'

type SortColumn =
  | 'id'
  | 'client_order_number'
  | 'client_id'
  | 'sample_type'
  | 'date_sampled'
  | 'review_state'
  | 'vial_count'
type SortDir = 'asc' | 'desc'

function SortableHead({
  column,
  label,
  activeColumn,
  direction,
  onSort,
  className,
}: {
  column: SortColumn
  label: string
  activeColumn: SortColumn | null
  direction: SortDir
  onSort: (col: SortColumn) => void
  className?: string
}) {
  const isActive = activeColumn === column
  return (
    <TableHead
      className={cn('cursor-pointer select-none', className)}
      onClick={() => onSort(column)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? (
          direction === 'asc' ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30" />
        )}
      </span>
    </TableHead>
  )
}

const STATE_LABELS: Record<string, { label: string; className: string }> = {
  sample_registered: {
    label: 'Registered',
    className: 'bg-zinc-700 text-zinc-200',
  },
  sample_due: { label: 'Due', className: 'bg-yellow-900 text-yellow-300' },
  sample_received: {
    label: 'Received',
    className: 'bg-blue-900 text-blue-300',
  },
  waiting_for_addon_results: {
    label: 'Waiting Addon',
    className: 'bg-indigo-900 text-indigo-300',
  },
  ready_for_review: {
    label: 'Ready for Review',
    className: 'bg-cyan-900 text-cyan-300',
  },
  to_be_verified: {
    label: 'To Verify',
    className: 'bg-orange-900 text-orange-300',
  },
  verified: { label: 'Verified', className: 'bg-green-900 text-green-300' },
  published: { label: 'Published', className: 'bg-purple-900 text-purple-300' },
  cancelled: { label: 'Cancelled', className: 'bg-red-900 text-red-300' },
  invalid: { label: 'Invalid', className: 'bg-red-900 text-red-300' },
}

function StateBadge({ state }: { state: string }) {
  const config = STATE_LABELS[state] ?? {
    label: state,
    className: 'bg-zinc-700 text-zinc-200',
  }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${config.className}`}
    >
      {config.label}
    </span>
  )
}

function VialCount({ sampleId }: { sampleId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['sub-samples-count', sampleId],
    queryFn: () => listSubSamples(sampleId),
    staleTime: 60_000,
  })

  if (isLoading) {
    return <span className="text-muted-foreground">—</span>
  }

  const count = data?.parent.sub_sample_count ?? 0
  return count > 0 ? (
    <span className="text-sm">{count} received</span>
  ) : (
    <span className="text-muted-foreground">—</span>
  )
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatRelativeDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return '—'
  const diff = Date.now() - date.getTime()
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (mins > 0) return `${mins}m ago`
  return 'just now'
}

/** Contacts whose samples are hidden unless "Show Test Samples" is checked. */
const TEST_CONTACTS = [
  'forrest@valenceanalytical.com',
  'valence internal 2',
  'val_int2',
]

export function ReceiveSample() {
  // Due samples list
  const [dueSamples, setDueSamples] = useState<SenaiteSample[]>([])
  const [dueSamplesLoading, setDueSamplesLoading] = useState(true)
  const [dueSamplesConnected, setDueSamplesConnected] = useState(false)
  const [dueSamplesError, setDueSamplesError] = useState<string | null>(null)
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [showTestSamples, setShowTestSamples] = useState(false)
  const [receiveMode, setReceiveMode] = useState<'order' | 'sample'>('order')
  const [selectedOrder, setSelectedOrder] = useState<OrderGroup | null>(null)

  // Sub-samples receive wizard (modal). Row click in the By-sample list opens
  // the wizard for that parent sample; the By-order list opens the order-scoped
  // OrderReceiveSession instead.
  const [wizardParent, setWizardParent] = useState<ParentInfo | null>(null)

  function handleSort(col: SortColumn) {
    if (sortColumn === col) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortColumn(col)
      setSortDir('asc')
    }
  }

  const filteredSamples = showTestSamples
    ? dueSamples
    : dueSamples.filter(
        s =>
          !s.client_id ||
          !TEST_CONTACTS.includes(s.client_id.toLowerCase())
      )

  const sortedSamples = sortColumn
    ? [...filteredSamples].sort((a, b) => {
        let cmp = 0
        if (sortColumn === 'vial_count') {
          // For vial_count, we'll do a client-side placeholder sort
          // Since vial counts are loaded lazily, this will sort by sample_id for now
          // The actual vial count data is fetched per-row via useQuery
          cmp = 0
        } else {
          const valA = a[sortColumn as keyof typeof a] ?? ''
          const valB = b[sortColumn as keyof typeof b] ?? ''
          cmp = String(valA).localeCompare(String(valB), undefined, {
            numeric: true,
          })
        }
        return sortDir === 'asc' ? cmp : -cmp
      })
    : filteredSamples

  const orderGroups = groupSamplesByOrder(filteredSamples)

  // Join the due-sample order groups to their ExplorerOrder for the By-Order
  // table (email, Created, customer deep-link). SLA verdicts are wired in a
  // follow-on task; OrderListRow renders the SLA cell in its awaiting state.
  const { data: explorerOrders } = useQuery({
    queryKey: ['explorer', 'orders', 'receive'],
    queryFn: () => getExplorerOrders(undefined, 200, 0),
    enabled: dueSamplesConnected,
    staleTime: 30_000,
  })

  const enriched = enrichOrderGroups(orderGroups, explorerOrders ?? [])

  // Page-level SLA verdicts for the By-Order table — mirror OrderStatusPage:
  // feed the matched ExplorerOrders to useSenaiteLookupMap (per-sample SENAITE
  // lookups) and useOrderSlaStatuses (one /sla/status batch), then select a
  // per-order verdict by order_id. Due-receive samples have no date_received
  // yet, so the SLA clock hasn't started and most resolve to "awaiting" — the
  // same not-started verdict Order Status shows for them.
  const slaOrders = useMemo(
    () =>
      enriched
        .map(g => g.order)
        .filter((o): o is ExplorerOrder => o != null),
    [enriched]
  )
  const { sampleLookupMap } = useSenaiteLookupMap(slaOrders)
  const orderSla = useOrderSlaStatuses(slaOrders, sampleLookupMap)

  const verdictFor = useCallback(
    (group: EnrichedOrderGroup): OrderSlaVerdict | undefined =>
      group.order
        ? orderSla.verdictByOrderId.get(group.order.order_id)
        : undefined,
    [orderSla.verdictByOrderId]
  )

  const handleProcessOrder = useCallback((group: EnrichedOrderGroup) => {
    setSelectedOrder(group)
  }, [])

  const loadDueSamples = useCallback(async () => {
    setDueSamplesLoading(true)
    setDueSamplesError(null)
    try {
      const status = await getSenaiteStatus()
      setDueSamplesConnected(status.enabled)
      if (status.enabled) {
        const result = await getSenaiteSamples('sample_due', 50, 0)
        setDueSamples(result.items)
      }
    } catch (e) {
      setDueSamplesConnected(false)
      setDueSamplesError(
        e instanceof Error ? e.message : 'Failed to load samples'
      )
    } finally {
      setDueSamplesLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDueSamples()
  }, [loadDueSamples])

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="flex-1">
        <div className="p-4 sm:p-6">
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold tracking-tight">Samples</h1>
                <p className="text-muted-foreground">
                  {dueSamplesConnected &&
                  !dueSamplesLoading &&
                  filteredSamples.length > 0
                    ? `${filteredSamples.length} due sample${filteredSamples.length !== 1 ? 's' : ''} — select one to receive`
                    : 'Select a due sample from SENAITE to receive'}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void loadDueSamples()}
                className="h-8 w-8"
                title="Refresh"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${dueSamplesLoading ? 'animate-spin' : ''}`}
                />
              </Button>
            </div>

            <div className="flex items-center justify-between gap-4">
              <label
                htmlFor="show-test-samples"
                className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none"
              >
                <Checkbox
                  id="show-test-samples"
                  checked={showTestSamples}
                  onCheckedChange={v => setShowTestSamples(v === true)}
                />
                Show Test Samples
              </label>

              <div className="inline-flex rounded-md border p-0.5 text-sm">
                <button
                  type="button"
                  onClick={() => setReceiveMode('order')}
                  className={cn(
                    'px-3 py-1 rounded',
                    receiveMode === 'order' && 'bg-accent font-semibold'
                  )}
                >
                  By order
                </button>
                <button
                  type="button"
                  onClick={() => setReceiveMode('sample')}
                  className={cn(
                    'px-3 py-1 rounded',
                    receiveMode === 'sample' && 'bg-accent font-semibold'
                  )}
                >
                  By sample
                </button>
              </div>
            </div>

            {dueSamplesLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !dueSamplesConnected ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
                <XCircle className="h-6 w-6" />
                <p className="text-sm">
                  {dueSamplesError ?? 'SENAITE not connected'}
                </p>
              </div>
            ) : dueSamplesError ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
                <XCircle className="h-6 w-6" />
                <p className="text-sm">{dueSamplesError}</p>
              </div>
            ) : dueSamples.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
                <FlaskConical className="h-6 w-6" />
                <p className="text-sm">No due samples found</p>
              </div>
            ) : receiveMode === 'order' ? (
              <div className="overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-36">Order #</TableHead>
                      <TableHead>Client / Email</TableHead>
                      <TableHead className="w-36">Created</TableHead>
                      <TableHead className="w-32">SLA</TableHead>
                      <TableHead className="w-24" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {enriched.map(group => (
                      <OrderListRow
                        key={group.orderKey ?? '__none__'}
                        group={group}
                        slaVerdict={verdictFor(group)}
                        onProcess={handleProcessOrder}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableHead
                        column="id"
                        label="Sample ID"
                        activeColumn={sortColumn}
                        direction={sortDir}
                        onSort={handleSort}
                        className="w-32"
                      />
                      <SortableHead
                        column="client_order_number"
                        label="Order #"
                        activeColumn={sortColumn}
                        direction={sortDir}
                        onSort={handleSort}
                        className="w-36"
                      />
                      <SortableHead
                        column="client_id"
                        label="Client"
                        activeColumn={sortColumn}
                        direction={sortDir}
                        onSort={handleSort}
                      />
                      <SortableHead
                        column="sample_type"
                        label="Sample Type"
                        activeColumn={sortColumn}
                        direction={sortDir}
                        onSort={handleSort}
                      />
                      <SortableHead
                        column="date_sampled"
                        label="Date Sampled"
                        activeColumn={sortColumn}
                        direction={sortDir}
                        onSort={handleSort}
                        className="w-36"
                      />
                      <SortableHead
                        column="vial_count"
                        label="Vials"
                        activeColumn={sortColumn}
                        direction={sortDir}
                        onSort={handleSort}
                        className="w-24 text-center"
                      />
                      <SortableHead
                        column="review_state"
                        label="State"
                        activeColumn={sortColumn}
                        direction={sortDir}
                        onSort={handleSort}
                        className="w-28 text-center"
                      />
                      <SortableHead
                        column="date_sampled"
                        label="Age"
                        activeColumn={sortColumn}
                        direction={sortDir}
                        onSort={handleSort}
                        className="w-20 text-right"
                      />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedSamples.map(s => (
                      <TableRow
                        key={s.uid}
                        className="cursor-pointer hover:bg-muted/30"
                        onClick={() => {
                          setWizardParent({
                            uid: s.uid,
                            sample_id: s.id,
                            status: s.review_state ?? null,
                          })
                        }}
                      >
                        <TableCell className="font-mono text-sm">
                          {s.id}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {s.client_order_number ?? '—'}
                        </TableCell>
                        <TableCell className="text-sm">
                          {s.client_id ?? '—'}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {s.sample_type ?? '—'}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatDate(s.date_sampled)}
                        </TableCell>
                        <TableCell className="text-center">
                          <VialCount sampleId={s.id} />
                        </TableCell>
                        <TableCell className="text-center">
                          <StateBadge state={s.review_state} />
                        </TableCell>
                        <TableCell className="text-right text-xs font-mono text-orange-400">
                          {formatRelativeDate(s.date_sampled)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>

      {/* Sub-samples receive wizard (modal) */}
      {wizardParent && (
        <Dialog
          open={Boolean(wizardParent)}
          onOpenChange={open => {
            if (!open) {
              setWizardParent(null)
              // Refresh the due-samples list so the row reflects the new state
              // (parent may have transitioned to received, vials added, etc.).
              void loadDueSamples()
            }
          }}
        >
          <DialogContent className="max-w-6xl w-full p-0 sm:max-w-6xl h-[90vh] overflow-hidden">
            <DialogHeader className="px-6 pt-4 pb-2 border-b">
              <DialogTitle>Receive {wizardParent.sample_id}</DialogTitle>
            </DialogHeader>
            <div className="h-[calc(90vh-3.5rem)] overflow-hidden">
              <ReceiveWizard
                parent={wizardParent}
                onClose={() => {
                  setWizardParent(null)
                  void loadDueSamples()
                }}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Order-scoped receive session (sample stepper + boxing stage) */}
      {selectedOrder && (
        <OrderReceiveSession
          order={selectedOrder}
          onClose={() => {
            setSelectedOrder(null)
            void loadDueSamples()
          }}
        />
      )}
    </div>
  )
}
