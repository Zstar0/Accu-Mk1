import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  FlaskConical,
  AlertTriangle,
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
  getPeptides,
  getExplorerOrders,
  getExplorerStatus,
  type PeptideRecord,
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
      if (order.status === 'accepted') bucket.completed++
      else if (order.status === 'failed' || order.status === 'partial_failure') bucket.failed++
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

// --- Dashboard ---

export function Dashboard() {
  const navigateTo = useUIStore(state => state.navigateTo)

  const [peptides, setPeptides] = useState<PeptideRecord[]>([])
  const [orders, setOrders] = useState<ExplorerOrder[]>([])
  const [ordersConnected, setOrdersConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [ordersLoading, setOrdersLoading] = useState(true)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getPeptides()
      setPeptides(data)
    } catch {
      // Peptides may not be available
    } finally {
      setLoading(false)
    }
  }, [])

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
    loadData()
    loadOrders()
  }, [loadData, loadOrders])

  // Derived data — filter out test orders
  const realOrders = orders.filter(o => !isTestOrder(o))
  const noCurvePeptides = peptides.filter(p => !p.active_calibration)
  const outstandingOrders = realOrders.filter(o => o.status === 'pending' || o.status === 'processing')
  const failedOrders = realOrders.filter(o => o.status === 'failed' || o.status === 'partial_failure')
  const completedOrders = realOrders.filter(o => o.status === 'accepted')
  const chartData = useMemo(() => buildOrderChart(realOrders), [realOrders])

  // Stats
  const todayKey = new Date().toISOString().split('T')[0] ?? ''
  const todayOrders = chartData.find(b => b.date === todayKey)?.total || 0

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 p-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">
            System overview and actionable items
          </p>
        </div>

        {/* KPI Row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10">
                  <FlaskConical className="h-4 w-4 text-blue-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{peptides.length}</p>
                  <p className="text-xs text-muted-foreground">Total Peptides</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${noCurvePeptides.length > 0 ? 'bg-yellow-500/10' : 'bg-green-500/10'}`}>
                  {noCurvePeptides.length > 0 ? (
                    <AlertTriangle className="h-4 w-4 text-yellow-400" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-green-400" />
                  )}
                </div>
                <div>
                  <p className="text-2xl font-bold">{noCurvePeptides.length}</p>
                  <p className="text-xs text-muted-foreground">Missing Curves</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-500/10">
                  <Package className="h-4 w-4 text-purple-400" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{todayOrders}</p>
                  <p className="text-xs text-muted-foreground">Orders Today</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${outstandingOrders.length > 0 ? 'bg-orange-500/10' : 'bg-green-500/10'}`}>
                  {outstandingOrders.length > 0 ? (
                    <Clock className="h-4 w-4 text-orange-400" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-green-400" />
                  )}
                </div>
                <div>
                  <p className="text-2xl font-bold">{outstandingOrders.length}</p>
                  <p className="text-xs text-muted-foreground">Outstanding</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Main panels */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Peptides Missing Curves */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-yellow-500" />
                    Peptides Without Curves
                  </CardTitle>
                  <CardDescription>
                    {noCurvePeptides.length === 0
                      ? 'All peptides have calibration curves'
                      : `${noCurvePeptides.length} peptide${noCurvePeptides.length !== 1 ? 's' : ''} need calibration data`}
                  </CardDescription>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1"
                  onClick={() => navigateTo('hplc-analysis', 'peptide-config')}
                >
                  Peptide Config
                  <ChevronRight className="h-3 w-3" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : noCurvePeptides.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-6 text-green-500">
                  <CheckCircle2 className="h-6 w-6" />
                  <p className="text-sm text-muted-foreground">All set!</p>
                </div>
              ) : (
                <div className="max-h-56 overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Peptide</TableHead>
                        <TableHead className="text-right">Ref RT</TableHead>
                        <TableHead className="text-center">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {noCurvePeptides.map(p => (
                        <TableRow
                          key={p.id}
                          className="cursor-pointer hover:bg-muted/30"
                          onClick={() => navigateTo('hplc-analysis', 'peptide-config')}
                        >
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{p.abbreviation}</span>
                              <span className="text-xs text-muted-foreground">{p.name}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {p.reference_rt != null ? `${p.reference_rt.toFixed(3)} min` : '—'}
                          </TableCell>
                          <TableCell className="text-center">
                            <Badge variant="outline" className="text-xs border-yellow-600/50 text-yellow-500">
                              No Curve
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
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
                <div className="h-48">
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
              <div className="max-h-72 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order ID</TableHead>
                      <TableHead>Order #</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead className="text-center">Status</TableHead>
                      <TableHead className="text-center">Samples</TableHead>
                      <TableHead className="text-right">Created</TableHead>
                      <TableHead className="text-right">Age</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...outstandingOrders, ...failedOrders].map(o => {
                      const email = getOrderEmail(o)
                      return (
                        <TableRow
                          key={o.id}
                          className="cursor-pointer hover:bg-muted/30"
                          onClick={() => navigateTo('accumark-tools', 'order-explorer')}
                        >
                          <TableCell className="font-mono text-sm">{o.order_id}</TableCell>
                          <TableCell className="text-sm">{o.order_number}</TableCell>
                          <TableCell className="text-sm truncate max-w-[160px]" title={email ?? ''}>
                            {email ? email.split('@')[0] + '@…' : '—'}
                          </TableCell>
                          <TableCell className="text-center">
                            <StatusBadge status={o.status} />
                          </TableCell>
                          <TableCell className="text-center text-sm">
                            {o.samples_delivered}/{o.samples_expected}
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground">
                            {new Date(o.created_at).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </TableCell>
                          <TableCell className="text-right text-xs font-mono text-orange-400">
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
      </div>
    </ScrollArea>
  )
}
