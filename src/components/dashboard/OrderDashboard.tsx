import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Clock,
  CheckCircle2,
  XCircle,
  RefreshCw,
  BarChart3,
  ChevronRight,
  Loader2,
  Package,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import {
  getExplorerOrders,
  getExplorerStatus,
  type ExplorerOrder,
} from '@/lib/api'
import { useUIStore } from '@/store/ui-store'

// --- Constants ---

const TEST_EMAILS = new Set([
  'forrestp@outlook.com',
  'aperture0@gmail.com',
  'forrest@valenceanalytical.com',
])

function getOrderEmail(order: ExplorerOrder): string | null {
  const payload = order.payload as Record<string, unknown> | null
  if (!payload?.billing || typeof payload.billing !== 'object') return null
  return ((payload.billing as Record<string, unknown>)?.email as string) ?? null
}

function isTestOrder(order: ExplorerOrder): boolean {
  const email = getOrderEmail(order)
  return email != null && TEST_EMAILS.has(email.toLowerCase())
}

// --- Helpers ---

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (mins > 0) return `${mins}m ago`
  return 'just now'
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; className?: string }> = {
    pending: { variant: 'secondary' },
    processing: { variant: 'secondary', className: 'animate-pulse' },
    accepted: { variant: 'default', className: 'bg-green-600' },
    failed: { variant: 'destructive' },
    partial_failure: { variant: 'destructive' },
  }
  const config = variants[status] || { variant: 'outline' as const }
  return (
    <Badge variant={config.variant} className={`text-xs ${config.className || ''}`}>
      {status}
    </Badge>
  )
}

// --- Chart helpers ---

interface DayBucket {
  date: string
  label: string
  total: number
  pending: number
  completed: number
  failed: number
}

function buildOrderChart(orders: ExplorerOrder[]): DayBucket[] {
  const days = 14
  const now = new Date()
  const buckets: DayBucket[] = []

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().split('T')[0] ?? ''
    buckets.push({
      date: key,
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      total: 0,
      pending: 0,
      completed: 0,
      failed: 0,
    })
  }

  const bucketMap = new Map(buckets.map(b => [b.date, b]))

  for (const order of orders) {
    const key = new Date(order.created_at).toISOString().split('T')[0] ?? ''
    const bucket = bucketMap.get(key)
    if (bucket) {
      bucket.total++
      if (order.status === 'failed' || order.status === 'partial_failure') bucket.failed++
      else if (order.completed_at) bucket.completed++
      else bucket.pending++
    }
  }

  return buckets
}

// Custom tooltip
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const value = payload[0]?.value ?? 0
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs shadow-xl">
      <p className="text-zinc-300 font-medium mb-1">{label}</p>
      <p className="text-zinc-400">{value} order{value !== 1 ? 's' : ''}</p>
    </div>
  )
}

// --- Order Dashboard ---

export function OrderDashboard() {
  const navigateTo = useUIStore(state => state.navigateTo)

  const [orders, setOrders] = useState<ExplorerOrder[]>([])
  const [ordersConnected, setOrdersConnected] = useState(false)
  const [ordersLoading, setOrdersLoading] = useState(true)

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true)
    try {
      const status = await getExplorerStatus()
      setOrdersConnected(status.connected)
      if (status.connected) {
        const data = await getExplorerOrders(undefined, 200, 0)
        setOrders(data)
      }
    } catch {
      setOrdersConnected(false)
    } finally {
      setOrdersLoading(false)
    }
  }, [])

  useEffect(() => {
    loadOrders()
  }, [loadOrders])

  // Derived data — filter out test orders
  const realOrders = orders.filter(o => !isTestOrder(o))
  const outstandingOrders = realOrders.filter(o => !o.completed_at && o.status !== 'failed' && o.status !== 'partial_failure')
  const failedOrders = realOrders.filter(o => o.status === 'failed' || o.status === 'partial_failure')
  const completedOrders = realOrders.filter(o => !!o.completed_at)
  const chartData = useMemo(() => buildOrderChart(realOrders), [realOrders])

  // Stats
  const todayKey = new Date().toISOString().split('T')[0] ?? ''
  const todayOrders = chartData.find(b => b.date === todayKey)?.total || 0

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 p-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Order Dashboard</h1>
          <p className="text-muted-foreground">
            Order tracking and fulfillment status
          </p>
        </div>

        {/* KPI Row */}
        <div className="flex items-center gap-6 text-sm">
          <div className="flex items-center gap-1.5">
            <Package className="h-3.5 w-3.5 text-purple-400" />
            <span className="font-semibold">{todayOrders}</span>
            <span className="text-muted-foreground">today</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Clock className={`h-3.5 w-3.5 ${outstandingOrders.length > 0 ? 'text-orange-400' : 'text-green-400'}`} />
            <span className="font-semibold">{outstandingOrders.length}</span>
            <span className="text-muted-foreground">outstanding</span>
          </div>
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />
            <span className="font-semibold">{completedOrders.length}</span>
            <span className="text-muted-foreground">completed</span>
          </div>
          <div className="flex items-center gap-1.5">
            <XCircle className={`h-3.5 w-3.5 ${failedOrders.length > 0 ? 'text-red-400' : 'text-muted-foreground'}`} />
            <span className="font-semibold">{failedOrders.length}</span>
            <span className="text-muted-foreground">failed</span>
          </div>
        </div>

        {/* Outstanding Orders + Chart side by side */}
        <div className="grid grid-cols-2 gap-6 items-start">

          {/* Outstanding Orders */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Clock className="h-4 w-4 text-orange-500" />
                    Outstanding Orders
                  </CardTitle>
                  <CardDescription>
                    {outstandingOrders.length === 0
                      ? 'No orders pending — all clear'
                      : `${outstandingOrders.length} order${outstandingOrders.length !== 1 ? 's' : ''} awaiting completion`}
                    {failedOrders.length > 0 && (
                      <span className="text-red-400 ml-2">
                        • {failedOrders.length} failed
                      </span>
                    )}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => { loadOrders() }}
                    className="h-8 w-8"
                    title="Refresh orders"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${ordersLoading ? 'animate-spin' : ''}`} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs gap-1"
                    onClick={() => navigateTo('accumark-tools', 'order-explorer')}
                  >
                    View All
                    <ChevronRight className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {ordersLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : !ordersConnected ? (
                <div className="flex flex-col items-center justify-center gap-2 py-6 text-muted-foreground">
                  <XCircle className="h-6 w-6" />
                  <p className="text-sm">Integration Service not connected</p>
                </div>
              ) : outstandingOrders.length === 0 && failedOrders.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-6 text-green-500">
                  <CheckCircle2 className="h-6 w-6" />
                  <p className="text-sm text-muted-foreground">
                    {completedOrders.length} orders completed
                  </p>
                </div>
              ) : (
                <div className="max-h-140 overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-24">Order</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead className="w-28 text-center">Status</TableHead>
                        <TableHead className="w-20 text-center">Samples</TableHead>
                        <TableHead className="w-20 text-right">Age</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...outstandingOrders, ...failedOrders].slice(0, 25).map(o => {
                        const email = getOrderEmail(o)
                        return (
                          <TableRow
                            key={o.id}
                            className="cursor-pointer hover:bg-muted/30"
                            onClick={() => navigateTo('accumark-tools', 'order-explorer')}
                          >
                            <TableCell className="font-mono text-sm w-24">{o.order_number || o.order_id}</TableCell>
                            <TableCell className="text-sm" title={email ?? ''}>
                              {email ?? '—'}
                            </TableCell>
                            <TableCell className="text-center w-28">
                              <StatusBadge status={o.status} />
                            </TableCell>
                            <TableCell className="text-center text-sm w-20">
                              {o.samples_delivered}/{o.samples_expected}
                            </TableCell>
                            <TableCell className="text-right text-xs font-mono text-orange-400 w-20">
                              {formatRelativeDate(o.created_at)}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Orders Chart */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-blue-500" />
                    Orders — Last 14 Days
                  </CardTitle>
                  <CardDescription>
                    {ordersConnected
                      ? `${orders.length} total orders loaded`
                      : 'Integration Service not connected'}
                  </CardDescription>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1"
                  onClick={() => navigateTo('accumark-tools', 'order-explorer')}
                >
                  Order Explorer
                  <ChevronRight className="h-3 w-3" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {ordersLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : !ordersConnected ? (
                <div className="flex flex-col items-center justify-center gap-2 py-6 text-muted-foreground">
                  <XCircle className="h-6 w-6" />
                  <p className="text-sm">Database not connected</p>
                </div>
              ) : (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                      <XAxis
                        dataKey="label"
                        tick={{ fill: '#71717a', fontSize: 10 }}
                        tickLine={false}
                        axisLine={{ stroke: '#3f3f46' }}
                      />
                      <YAxis
                        allowDecimals={false}
                        tick={{ fill: '#71717a', fontSize: 10 }}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(59,130,246,0.08)' }} />
                      <Bar dataKey="total" radius={[4, 4, 0, 0]} maxBarSize={32}>
                        {chartData.map((entry, i) => (
                          <Cell
                            key={i}
                            fill={entry.date === todayKey ? '#3b82f6' : '#3f3f46'}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

        </div>
      </div>
    </ScrollArea>
  )
}
