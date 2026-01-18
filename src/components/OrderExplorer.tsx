import { useState, useEffect } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { Search, Database, RefreshCw, ChevronRight, AlertCircle, CheckCircle2, Clock, XCircle } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  getExplorerStatus,
  getExplorerOrders,
  getOrderIngestions,
  getExplorerEnvironments,
  setExplorerEnvironment,
  type ExplorerOrder,
  type ExplorerIngestion,
} from '@/lib/api'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'


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
 * Ingestions panel showing COAs for selected order.
 */
function IngestionsPanel({ 
  orderId, 
  wordpressHost,
  onClose 
}: { 
  orderId: string
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sample ID</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Verification Code</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ingestions.map((ing: ExplorerIngestion) => (
                <TableRow key={ing.id}>
                  <TableCell className="font-mono text-sm">{ing.sample_id}</TableCell>
                  <TableCell>v{ing.coa_version}</TableCell>
                  <TableCell>
                    <StatusBadge status={ing.status} />
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {ing.verification_code ? (
                      <a
                        href={getVerifyUrl(ing.verification_code)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline cursor-pointer"
                      >
                        {ing.verification_code}
                      </a>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(ing.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshSuccess, setRefreshSuccess] = useState(false)
  const queryClient = useQueryClient()

  // Clear refresh success indicator after 2 seconds
  useEffect(() => {
    if (refreshSuccess) {
      const timer = setTimeout(() => setRefreshSuccess(false), 2000)
      return () => clearTimeout(timer)
    }
  }, [refreshSuccess])

  // Connection status
  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['explorer', 'status'],
    queryFn: getExplorerStatus,
    staleTime: 30000, // 30 seconds
  })

  // Available environments
  const { data: envData } = useQuery({
    queryKey: ['explorer', 'environments'],
    queryFn: getExplorerEnvironments,
  })

  // Environment switch mutation
  const switchEnvMutation = useMutation({
    mutationFn: setExplorerEnvironment,
    onSuccess: () => {
      // Invalidate all explorer queries to refresh data
      queryClient.invalidateQueries({ queryKey: ['explorer'] })
    },
  })

  // Orders query
  const {
    data: orders,
    isLoading: ordersLoading,
    error: ordersError,
    refetch,
  } = useQuery({
    queryKey: ['explorer', 'orders', debouncedSearch],
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
    setSelectedOrderId(order.order_id)
  }

  const handleEnvironmentChange = (env: string) => {
    setSelectedOrderId(null) // Clear selection when switching
    switchEnvMutation.mutate(env)
  }

  const handleRefresh = async () => {
    setIsRefreshing(true)
    setRefreshSuccess(false)
    await queryClient.invalidateQueries({ queryKey: ['explorer'] })
    setIsRefreshing(false)
    setRefreshSuccess(true)
  }


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

        {/* Environment selector and status */}
        <div className="flex items-center gap-3">
          {/* Environment dropdown */}
          {envData && (
            <>
              <Select
                value={envData.current}
                onValueChange={handleEnvironmentChange}
                disabled={switchEnvMutation.isPending}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Environment" />
                </SelectTrigger>
                <SelectContent>
                  {envData.environments.map((env) => (
                    <SelectItem key={env} value={env}>
                      {env.charAt(0).toUpperCase() + env.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon"
                onClick={handleRefresh}
                disabled={switchEnvMutation.isPending || statusLoading || isRefreshing}
                title="Refresh data"
              >
                <RefreshCw className={cn('h-4 w-4', (isRefreshing || ordersLoading || switchEnvMutation.isPending) && 'animate-spin')} />
              </Button>
              {refreshSuccess && (
                <CheckCircle2 
                  className="h-5 w-5 text-green-500 animate-in fade-in zoom-in duration-200" 
                  style={{ animation: 'fadeIn 0.2s ease-in, fadeOut 0.5s ease-out 1.5s forwards' }}
                />
              )}
            </>
          )}

          {/* Connection status badge */}
          {(statusLoading || switchEnvMutation.isPending) && (
            <Badge variant="secondary">
              <RefreshCw className="h-3 w-3 animate-spin mr-1" />
              {switchEnvMutation.isPending ? 'Switching...' : 'Connecting...'}
            </Badge>
          )}
          {status?.connected && !switchEnvMutation.isPending && (
            <Badge variant="default" className="bg-green-600">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          )}
          {status && !status.connected && !switchEnvMutation.isPending && (
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
              <ScrollArea className="h-[300px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order ID</TableHead>
                      <TableHead>Order Number</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Samples</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.map((order: ExplorerOrder) => (
                      <TableRow
                        key={order.id}
                        className={cn(
                          'cursor-pointer hover:bg-muted/50',
                          selectedOrderId === order.order_id && 'bg-muted'
                        )}
                        onClick={() => handleOrderClick(order)}
                      >
                        <TableCell className="font-mono">{order.order_id}</TableCell>
                        <TableCell>{order.order_number}</TableCell>
                        <TableCell>
                          <StatusBadge status={order.status} />
                        </TableCell>
                        <TableCell>
                          {order.samples_delivered}/{order.samples_expected}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(order.created_at)}
                        </TableCell>
                        <TableCell>
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      )}

      {/* Ingestions panel */}
      {selectedOrderId && (
        <IngestionsPanel
          orderId={selectedOrderId}
          wordpressHost={status?.wordpress_host}
          onClose={() => setSelectedOrderId(null)}
        />
      )}
    </div>
  )
}
