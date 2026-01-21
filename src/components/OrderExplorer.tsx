import { useState, useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, Database, RefreshCw, ChevronRight, AlertCircle, CheckCircle2, Clock, XCircle } from 'lucide-react'
import { ColumnDef } from '@tanstack/react-table'

import { cn } from '@/lib/utils'
import {
  getExplorerStatus,
  getExplorerOrders,
  getOrderIngestions,
  type ExplorerOrder,
  type ExplorerIngestion,
} from '@/lib/api'
import {
  getProfiles,
  getActiveProfileId,
  setActiveProfileId,
  API_PROFILE_CHANGED_EVENT,
} from '@/lib/api-profiles'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DataTable } from '@/components/ui/data-table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PayloadPanel } from '@/components/PayloadPanel'


/**
 * Status badge component with appropriate colors.
 */
function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: React.ReactNode }> = {
    pending: { variant: 'secondary', icon: <Clock className="h-3 w-3" /> },
    processing: { variant: 'secondary', icon: <RefreshCw className="h-3 w-3 animate-spin" /> },
    accepted: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3" /> },
    uploaded: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3" /> },
    notified: { variant: 'default', icon: <CheckCircle2 className="h-3 w-3" /> },
    failed: { variant: 'destructive', icon: <XCircle className="h-3 w-3" /> },
    error: { variant: 'destructive', icon: <XCircle className="h-3 w-3" /> },
    validation_failed: { variant: 'destructive', icon: <AlertCircle className="h-3 w-3" /> },
  }

  const config = variants[status] || { variant: 'outline' as const, icon: null }

  return (
    <Badge variant={config.variant} className="gap-1">
      {config.icon}
      {status}
    </Badge>
  )
}


/**
 * Format datetime for display.
 */
function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const date = new Date(dateStr)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}


/**
 * Calculate and format processing time.
 */
function formatProcessingTime(createdAt: string, completedAt: string | null): string {
  const start = new Date(createdAt)
  const end = completedAt ? new Date(completedAt) : new Date()
  const diffMs = end.getTime() - start.getTime()
  
  return formatMilliseconds(diffMs)
}


/**
 * Format milliseconds into human-readable duration.
 */
function formatMilliseconds(ms: number): string {
  if (ms < 0) return '—'
  
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  
  if (days > 0) {
    return `${days}d ${hours % 24}h`
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`
  } else if (seconds > 0) {
    return `${seconds}s`
  } else {
    return `${ms}ms`
  }
}


/**
 * Ingestions panel showing COAs for selected order.
 */
function IngestionsPanel({ 
  orderId, 
  orderCreatedAt,
  wordpressHost,
  onClose,
}: { 
  orderId: string
  orderCreatedAt: string
  wordpressHost?: string
  onClose: () => void
}) {
  const { data: ingestions, isLoading, error } = useQuery({
    queryKey: ['explorer', 'ingestions', orderId],
    queryFn: () => getOrderIngestions(orderId),
  })

  // Build verify URL for a code
  const getVerifyUrl = (code: string) => {
    const baseUrl = wordpressHost || 'https://accumarklabs.local'
    return `${baseUrl}/verify?code=${code}`
  }

  // Column definitions for ingestions table
  const columns: ColumnDef<ExplorerIngestion>[] = useMemo(() => [
    {
      accessorKey: 'sample_id',
      header: 'Sample ID',
      size: 120,
      cell: ({ row }) => (
        <span className="font-mono text-sm">{row.original.sample_id}</span>
      ),
    },
    {
      accessorKey: 'coa_version',
      header: 'Version',
      size: 70,
      cell: ({ row }) => `v${row.original.coa_version}`,
    },
    {
      accessorKey: 'status',
      header: 'Status',
      size: 100,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: 'verification_code',
      header: 'Verification Code',
      size: 140,
      cell: ({ row }) => {
        const code = row.original.verification_code
        if (!code) return <span className="text-muted-foreground">—</span>
        return (
          <a
            href={getVerifyUrl(code)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-sm text-primary hover:underline"
          >
            {code}
          </a>
        )
      },
    },
    {
      accessorKey: 'completed_at',
      header: 'Completed',
      size: 130,
      cell: ({ row }) => (
        <span className="text-muted-foreground">{formatDate(row.original.completed_at)}</span>
      ),
    },
    {
      id: 'processing_time',
      header: 'Processing Time',
      size: 120,
      cell: ({ row }) => {
        const ing = row.original
        return (
          <span className={cn(
            'font-mono text-sm',
            ing.completed_at ? 'text-green-600' : 'text-yellow-600'
          )}>
            {formatProcessingTime(orderCreatedAt, ing.completed_at)}
            {!ing.completed_at && ' ⏳'}
          </span>
        )
      },
    },
  ], [orderCreatedAt, getVerifyUrl])

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Ingestions for Order #{orderId}</CardTitle>
            <CardDescription>COA records linked to this order</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            ✕
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground py-4">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Loading ingestions...
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-destructive py-4">
            <AlertCircle className="h-4 w-4" />
            Failed to load ingestions
          </div>
        )}

        {ingestions && ingestions.length === 0 && (
          <div className="text-muted-foreground py-4 text-center">
            No ingestions found for this order
          </div>
        )}

        {ingestions && ingestions.length > 0 && (
          <DataTable
            columns={columns}
            data={ingestions}
            getRowId={(row) => String(row.id)}
          />
        )}
      </CardContent>
    </Card>
  )
}



/**
 * Order Explorer - Debugging tool for viewing Integration Service data.
 */
export function OrderExplorer() {
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [selectedOrder, setSelectedOrder] = useState<ExplorerOrder | null>(null)

  // Profile state
  const [activeProfileId, setActiveProfileIdState] = useState<string | null>(getActiveProfileId())
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
    }
    window.addEventListener(API_PROFILE_CHANGED_EVENT, handleProfileChange)
    return () => window.removeEventListener(API_PROFILE_CHANGED_EVENT, handleProfileChange)
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
    staleTime: 0, // Always check fresh when profile changes
    enabled: !!activeProfileId,
  })

  // Orders query
  const {
    data: orders,
    isLoading: ordersLoading,
    error: ordersError,
    refetch,
  } = useQuery({
    queryKey: ['explorer', 'orders', debouncedSearch, activeProfileId],
    queryFn: () => getExplorerOrders(debouncedSearch || undefined),
    enabled: status?.connected === true,
  })

  // Handle search with debounce
  const handleSearchChange = (value: string) => {
    setSearchTerm(value)
    // Simple debounce using timeout
    setTimeout(() => {
      setDebouncedSearch(value)
    }, 300)
  }

  const handleOrderClick = (order: ExplorerOrder) => {
    setSelectedOrder(order)
    setSelectedPayload(null) // Close payload panel when selecting different order
  }

  const handleConnectionChange = async (profileId: string) => {
    // Set active profile (this triggers saveState -> dispatch event)
    setActiveProfileId(profileId)
    setActiveProfileIdState(profileId)
    
    // Reset local state
    setSelectedOrder(null)
    setSelectedPayload(null)
    
    // Clear cache and refresh
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
  const ordersColumns: ColumnDef<ExplorerOrder>[] = useMemo(() => [
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
        <span>{row.original.samples_delivered}/{row.original.samples_expected}</span>
      ),
    },
    {
      accessorKey: 'created_at',
      header: 'Created',
      size: 130,
      minSize: 80,
      cell: ({ row }) => (
        <span className="text-muted-foreground">{formatDate(row.original.created_at)}</span>
      ),
    },
    {
      accessorKey: 'completed_at',
      header: 'Completed',
      size: 130,
      minSize: 80,
      cell: ({ row }) => (
        <span className="text-muted-foreground">{formatDate(row.original.completed_at)}</span>
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
          <span className={cn(
            'font-mono text-sm',
            order.completed_at ? 'text-green-600' : 'text-yellow-600'
          )}>
            {formatProcessingTime(order.created_at, order.completed_at)}
            {!order.completed_at && ' ⏳'}
          </span>
        )
      },
    },
    {
      id: 'payload',
      header: 'Payload',
      size: 70,
      minSize: 50,
      cell: ({ row }) => {
        const order = row.original
        if (!order.payload) return <span className="text-muted-foreground">—</span>
        return (
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              setSelectedPayload({ payload: order.payload, sampleId: order.order_id })
            }}
          >
            View
          </Button>
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
  ], [])


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
              View orders and ingestions from the Integration Service
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
              {profiles.map((profile) => (
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
            <RefreshCw className={cn('h-4 w-4', (isRefreshing || ordersLoading) && 'animate-spin')} />
          </Button>

          {refreshSuccess && (
            <CheckCircle2 
              className="h-5 w-5 text-green-500 animate-in fade-in zoom-in duration-200" 
              style={{ animation: 'fadeIn 0.2s ease-in, fadeOut 0.5s ease-out 1.5s forwards' }}
            />
          )}

          {/* Connection status badge */}
          {(statusLoading) && (
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

      {/* Search and refresh */}
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
          <Button variant="outline" size="icon" onClick={() => refetch()}>
            <RefreshCw className={cn('h-4 w-4', ordersLoading && 'animate-spin')} />
          </Button>
        </div>
      )}

      {/* Orders table */}
      {status?.connected && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Orders</CardTitle>
            <CardDescription>
              {orders?.length ?? 0} orders found. Click to view ingestions.
            </CardDescription>
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
                {debouncedSearch ? 'No orders match your search' : 'No orders found'}
              </div>
            )}

            {orders && orders.length > 0 && (
              <div className="max-h-[300px] overflow-auto">
                <DataTable
                  columns={ordersColumns}
                  data={orders}
                  onRowClick={handleOrderClick}
                  selectedRowId={selectedOrder?.order_id}
                  getRowId={(row) => row.order_id}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Ingestions panel */}
      {selectedOrder && (
        <IngestionsPanel
          orderId={selectedOrder.order_id}
          orderCreatedAt={selectedOrder.created_at}
          wordpressHost={status?.wordpress_host}
          onClose={() => setSelectedOrder(null)}
        />
      )}

      {/* Payload panel - shows in right area */}
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
