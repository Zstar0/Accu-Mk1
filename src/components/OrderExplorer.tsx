import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Search,
  Database,
  RefreshCw,
  ChevronRight,
  ChevronLeft,
  AlertCircle,
  CheckCircle2,
  Clock,
  XCircle,
} from 'lucide-react'
import type { ColumnDef } from '@tanstack/react-table'

import { cn } from '@/lib/utils'
import {
  getExplorerStatus,
  getExplorerOrders,
  type ExplorerOrder,
} from '@/lib/api'
import {
  getProfiles,
  getActiveProfileId,
  getActiveProfile,
  setActiveProfileId,
  API_PROFILE_CHANGED_EVENT,
} from '@/lib/api-profiles'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { DataTable } from '@/components/ui/data-table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PayloadPanel } from '@/components/PayloadPanel'
import { OrderDetailPanel } from '@/components/explorer/OrderDetailPanel'

// --- Helpers ---

function StatusBadge({ status }: { status: string }) {
  const variants: Record<
    string,
    {
      variant: 'default' | 'secondary' | 'destructive' | 'outline'
      icon: React.ReactNode
    }
  > = {
    pending: { variant: 'secondary', icon: <Clock className="h-3 w-3" /> },
    processing: {
      variant: 'secondary',
      icon: <RefreshCw className="h-3 w-3 animate-spin" />,
    },
    accepted: {
      variant: 'default',
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    failed: { variant: 'destructive', icon: <XCircle className="h-3 w-3" /> },
    partial_failure: {
      variant: 'destructive',
      icon: <AlertCircle className="h-3 w-3" />,
    },
  }

  const config = variants[status] || { variant: 'outline' as const, icon: null }

  return (
    <Badge variant={config.variant} className="gap-1">
      {config.icon}
      {status}
    </Badge>
  )
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '\u2014'
  const date = new Date(dateStr)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatProcessingTime(
  createdAt: string,
  completedAt: string | null
): string {
  const start = new Date(createdAt)
  const end = completedAt ? new Date(completedAt) : new Date()
  const ms = end.getTime() - start.getTime()
  if (ms < 0) return '\u2014'

  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  if (seconds > 0) return `${seconds}s`
  return `${ms}ms`
}

function SampleIdCell({
  sampleResults,
}: {
  sampleResults: Record<string, { senaite_id: string; status: string }> | null
}) {
  const [expanded, setExpanded] = useState(false)

  if (!sampleResults) return <span className="text-muted-foreground">{'\u2014'}</span>

  const ids = Object.values(sampleResults).map(s => s.senaite_id)
  if (ids.length === 0) return <span className="text-muted-foreground">{'\u2014'}</span>

  const visible = expanded ? ids : ids.slice(0, 2)
  const remaining = ids.length - 2

  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map(id => (
        <Badge key={id} variant="outline" className="font-mono text-xs px-1.5 py-0">
          {id}
        </Badge>
      ))}
      {!expanded && remaining > 0 && (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={e => {
            e.stopPropagation()
            setExpanded(true)
          }}
        >
          +{remaining} more
        </button>
      )}
      {expanded && ids.length > 2 && (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={e => {
            e.stopPropagation()
            setExpanded(false)
          }}
        >
          show less
        </button>
      )}
    </div>
  )
}

const PAGE_SIZE = 50

const STATUS_OPTIONS = [
  { value: 'all', label: 'All Statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'processing', label: 'Processing' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'partial_failure', label: 'Partial Failure' },
  { value: 'failed', label: 'Failed' },
]

/**
 * Order Explorer - Debugging tool for viewing Integration Service data.
 */
export function OrderExplorer() {
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [page, setPage] = useState(0)
  const [selectedOrder, setSelectedOrder] = useState<ExplorerOrder | null>(null)

  // Profile state
  const [activeProfileId, setActiveProfileIdState] = useState<string | null>(
    getActiveProfileId()
  )
  const profiles = getProfiles()

  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshSuccess, setRefreshSuccess] = useState(false)
  const [selectedPayload, setSelectedPayload] = useState<{
    payload: Record<string, unknown> | null
    sampleId: string
  } | null>(null)
  const queryClient = useQueryClient()

  // Listen for profile changes
  useEffect(() => {
    const handleProfileChange = () => {
      setActiveProfileIdState(getActiveProfileId())
      setSelectedOrder(null)
      setSelectedPayload(null)
      setPage(0)
    }
    window.addEventListener(API_PROFILE_CHANGED_EVENT, handleProfileChange)
    return () =>
      window.removeEventListener(API_PROFILE_CHANGED_EVENT, handleProfileChange)
  }, [])

  // Clear refresh success indicator after 2 seconds
  useEffect(() => {
    if (refreshSuccess) {
      const timer = setTimeout(() => setRefreshSuccess(false), 2000)
      return () => clearTimeout(timer)
    }
  }, [refreshSuccess])

  // Connection status
  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['explorer', 'status', activeProfileId],
    queryFn: getExplorerStatus,
    staleTime: 0,
    enabled: !!activeProfileId,
  })

  // Orders query with status filter and pagination
  const {
    data: orders,
    isLoading: ordersLoading,
    error: ordersError,
    refetch,
  } = useQuery({
    queryKey: [
      'explorer',
      'orders',
      debouncedSearch,
      statusFilter,
      page,
      activeProfileId,
    ],
    queryFn: () =>
      getExplorerOrders(
        debouncedSearch || undefined,
        PAGE_SIZE,
        page * PAGE_SIZE,
        statusFilter === 'all' ? undefined : statusFilter
      ),
    enabled: status?.connected === true,
  })

  // Handle search with debounce
  const handleSearchChange = (value: string) => {
    setSearchTerm(value)
    setPage(0)
    setTimeout(() => {
      setDebouncedSearch(value)
    }, 300)
  }

  const handleStatusFilterChange = (value: string) => {
    setStatusFilter(value)
    setPage(0)
  }

  const handleOrderClick = (order: ExplorerOrder) => {
    setSelectedOrder(order)
    setSelectedPayload(null)
  }

  const handleConnectionChange = async (profileId: string) => {
    setActiveProfileId(profileId)
    setActiveProfileIdState(profileId)
    setSelectedOrder(null)
    setSelectedPayload(null)
    setPage(0)
    queryClient.clear()
    await queryClient.invalidateQueries({ queryKey: ['explorer'] })
    refetch()
  }

  const handleRefresh = async () => {
    setIsRefreshing(true)
    setRefreshSuccess(false)
    await queryClient.invalidateQueries({ queryKey: ['explorer'] })
    setIsRefreshing(false)
    setRefreshSuccess(true)
  }

  // Column definitions for orders table
  const ordersColumns: ColumnDef<ExplorerOrder>[] = [
    {
      accessorKey: 'order_id',
      header: 'Order ID',
      size: 80,
      minSize: 50,
      cell: ({ row }) => (
        <span className="font-mono text-sm">{row.original.order_id}</span>
      ),
    },
    {
      accessorKey: 'order_number',
      header: 'Order #',
      size: 80,
      minSize: 50,
      cell: ({ row }) => (
        <span className="text-sm">{row.original.order_number}</span>
      ),
    },
    {
      id: 'email',
      header: 'Email',
      size: 140,
      minSize: 80,
      cell: ({ row }) => {
        const email =
          (row.original.payload as Record<string, unknown> | null)?.billing &&
          typeof (row.original.payload as Record<string, unknown>).billing ===
            'object'
            ? (
                (row.original.payload as Record<string, Record<string, unknown>>)
                  .billing?.email as string | undefined
              ) ?? null
            : null
        if (!email) return <span className="text-muted-foreground">{'\u2014'}</span>
        const localPart = email.split('@')[0]
        return (
          <span className="text-sm truncate block max-w-[130px]" title={email}>
            {localPart}@...
          </span>
        )
      },
    },
    {
      accessorKey: 'status',
      header: 'Status',
      size: 100,
      minSize: 60,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: 'samples',
      header: 'Samples',
      size: 70,
      minSize: 50,
      cell: ({ row }) => (
        <span>
          {row.original.samples_delivered}/{row.original.samples_expected}
        </span>
      ),
    },
    {
      id: 'sample_ids',
      header: 'Sample IDs',
      size: 160,
      minSize: 80,
      cell: ({ row }) => <SampleIdCell sampleResults={row.original.sample_results} />,
    },
    {
      accessorKey: 'created_at',
      header: 'Created',
      size: 130,
      minSize: 80,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {formatDate(row.original.created_at)}
        </span>
      ),
    },
    {
      accessorKey: 'completed_at',
      header: 'Completed',
      size: 130,
      minSize: 80,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {formatDate(row.original.completed_at)}
        </span>
      ),
    },
    {
      id: 'processing_time',
      header: 'Processing Time',
      size: 120,
      minSize: 80,
      cell: ({ row }) => {
        const order = row.original
        return (
          <span
            className={cn(
              'font-mono text-sm',
              order.completed_at ? 'text-green-600' : 'text-yellow-600'
            )}
          >
            {formatProcessingTime(order.created_at, order.completed_at)}
          </span>
        )
      },
    },
    {
      id: 'chevron',
      header: '',
      size: 32,
      minSize: 32,
      enableResizing: false,
      cell: () => <ChevronRight className="h-4 w-4 text-muted-foreground" />,
    },
  ]

  const hasNextPage = orders && orders.length === PAGE_SIZE
  const hasPrevPage = page > 0

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Database className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-semibold">Order Explorer</h2>
            <p className="text-sm text-muted-foreground">
              Browse orders and ingestions from the Integration Service
            </p>
          </div>
        </div>

        {/* Profile selector and status */}
        <div className="flex items-center gap-3">
          <Select
            value={activeProfileId || ''}
            onValueChange={handleConnectionChange}
            disabled={isRefreshing}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Select Profile" />
            </SelectTrigger>
            <SelectContent>
              {profiles.map(profile => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="icon"
            onClick={handleRefresh}
            disabled={statusLoading || isRefreshing}
            title="Refresh data"
          >
            <RefreshCw
              className={cn(
                'h-4 w-4',
                (isRefreshing || ordersLoading) && 'animate-spin'
              )}
            />
          </Button>

          {refreshSuccess && (
            <CheckCircle2 className="h-5 w-5 text-green-500 animate-in fade-in zoom-in duration-200" />
          )}

          {/* Connection status badge */}
          {statusLoading && (
            <Badge variant="secondary">
              <RefreshCw className="h-3 w-3 animate-spin mr-1" />
              Connecting...
            </Badge>
          )}
          {status?.connected && !statusLoading && (
            <Badge variant="default" className="bg-green-600">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          )}
          {status && !status.connected && !statusLoading && (
            <Badge variant="destructive">
              <XCircle className="h-3 w-3 mr-1" />
              Disconnected
            </Badge>
          )}
        </div>
      </div>

      {/* Connection error */}
      {status && !status.connected && (
        <Card className="border-destructive">
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span>Failed to connect to database: {status.error}</span>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              Make sure the Integration Service PostgreSQL container is running.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Search, status filter */}
      {status?.connected && (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by Order ID or Order Number..."
              value={searchTerm}
              onChange={e => handleSearchChange(e.target.value)}
              className="pl-10"
            />
          </div>
          <Select value={statusFilter} onValueChange={handleStatusFilterChange}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Orders table */}
      {status?.connected && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">Orders</CardTitle>
                <CardDescription>
                  {orders
                    ? `${orders.length} orders${orders.length === PAGE_SIZE ? '+' : ''}`
                    : 'Loading...'}
                  {statusFilter !== 'all' && ` (filtered: ${statusFilter})`}.
                  Click to view details.
                </CardDescription>
              </div>
              {/* Pagination */}
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => p - 1)}
                  disabled={!hasPrevPage || ordersLoading}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Prev
                </Button>
                <span className="text-sm text-muted-foreground min-w-[60px] text-center">
                  Page {page + 1}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => p + 1)}
                  disabled={!hasNextPage || ordersLoading}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {ordersLoading && (
              <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Loading orders...
              </div>
            )}

            {ordersError && (
              <div className="flex items-center gap-2 text-destructive py-8 justify-center">
                <AlertCircle className="h-4 w-4" />
                Failed to load orders
              </div>
            )}

            {orders && orders.length === 0 && !ordersLoading && (
              <div className="text-muted-foreground py-8 text-center">
                {debouncedSearch
                  ? 'No orders match your search'
                  : 'No orders found'}
              </div>
            )}

            {orders && orders.length > 0 && (
              <div className="max-h-[300px] overflow-auto">
                <DataTable
                  columns={ordersColumns}
                  data={orders}
                  onRowClick={handleOrderClick}
                  selectedRowId={selectedOrder?.order_id}
                  getRowId={row => row.order_id}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Order detail panel (tabbed) */}
      {selectedOrder && (
        <OrderDetailPanel
          order={selectedOrder}
          wordpressHost={getActiveProfile()?.wordpressUrl}
          onClose={() => setSelectedOrder(null)}
          onViewPayload={order =>
            setSelectedPayload({
              payload: order.payload,
              sampleId: order.order_id,
            })
          }
        />
      )}

      {/* Payload panel */}
      {selectedPayload && (
        <PayloadPanel
          payload={selectedPayload.payload}
          orderId={selectedPayload.sampleId}
          onClose={() => setSelectedPayload(null)}
        />
      )}
    </div>
  )
}
