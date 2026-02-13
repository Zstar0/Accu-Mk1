import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ExternalLink,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Clock,
  XCircle,
  X,
  Download,
  Image,
  FileText,
  Eye,
  Shield,
} from 'lucide-react'
import type { ColumnDef } from '@tanstack/react-table'

import { cn } from '@/lib/utils'
import {
  getOrderIngestions,
  getOrderAttempts,
  getOrderCOAGenerations,
  getOrderSampleEvents,
  getOrderAccessLogs,
  getExplorerCOASignedUrl,
  getExplorerChromatogramSignedUrl,
  type ExplorerOrder,
  type ExplorerIngestion,
  type ExplorerAttempt,
  type ExplorerCOAGeneration,
  type ExplorerSampleEvent,
  type ExplorerAccessLog,
} from '@/lib/api'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DataTable } from '@/components/ui/data-table'

// --- Shared helpers ---

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
    uploaded: {
      variant: 'default',
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    notified: {
      variant: 'default',
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    published: {
      variant: 'default',
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    draft: { variant: 'outline', icon: <Clock className="h-3 w-3" /> },
    superseded: {
      variant: 'secondary',
      icon: <XCircle className="h-3 w-3" />,
    },
    success: {
      variant: 'default',
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    partial: {
      variant: 'secondary',
      icon: <AlertCircle className="h-3 w-3" />,
    },
    failed: { variant: 'destructive', icon: <XCircle className="h-3 w-3" /> },
    error: { variant: 'destructive', icon: <XCircle className="h-3 w-3" /> },
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

// --- Download Button ---

function DownloadCOAButton({
  sampleId,
  version,
}: {
  sampleId: string
  version: number
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleDownload = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getExplorerCOASignedUrl(sampleId, version)
      window.open(result.url, '_blank')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed')
    } finally {
      setLoading(false)
    }
  }

  if (error) {
    return (
      <span className="text-xs text-destructive flex items-center gap-1" title={error}>
        <AlertCircle className="h-3 w-3" />
        No PDF
      </span>
    )
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs"
      onClick={handleDownload}
      disabled={loading}
      title="Download COA PDF"
    >
      {loading ? (
        <RefreshCw className="h-3 w-3 animate-spin" />
      ) : (
        <Download className="h-3 w-3" />
      )}
      COA
    </Button>
  )
}

function ViewChromatogramButton({ sampleId }: { sampleId: string }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleView = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getExplorerChromatogramSignedUrl(sampleId, 1)
      window.open(result.url, '_blank')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  if (error) {
    return (
      <span className="text-xs text-destructive flex items-center gap-1" title={error}>
        <AlertCircle className="h-3 w-3" />
        Not found
      </span>
    )
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs"
      onClick={handleView}
      disabled={loading}
      title="View Chromatogram"
    >
      {loading ? (
        <RefreshCw className="h-3 w-3 animate-spin" />
      ) : (
        <Image className="h-3 w-3" />
      )}
      Chromatogram
    </Button>
  )
}

// --- Summary Tab ---

function SummaryTab({
  order,
  wordpressHost,
}: {
  order: ExplorerOrder
  wordpressHost?: string
}) {
  const wpAdminUrl = wordpressHost
    ? `${wordpressHost}/wp-admin/post.php?post=${order.order_id}&action=edit`
    : null

  return (
    <div className="grid grid-cols-2 gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Order Info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Order ID</span>
            <span className="font-mono">{order.order_id}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Order #</span>
            <span>{order.order_number}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Status</span>
            <StatusBadge status={order.status} />
          </div>
          {order.error_message && (
            <div className="mt-2 p-2 rounded bg-destructive/10 text-destructive text-xs">
              {order.error_message}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Timing & Samples</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Created</span>
            <span>{formatDate(order.created_at)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Completed</span>
            <span>{formatDate(order.completed_at)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Processing Time</span>
            <span className="font-mono">
              {formatProcessingTime(order.created_at, order.completed_at)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Samples</span>
            <span>
              {order.samples_delivered}/{order.samples_expected} delivered
            </span>
          </div>
        </CardContent>
      </Card>

      {/* External links */}
      <Card className="col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">External Links</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2">
          {wpAdminUrl && (
            <Button variant="outline" size="sm" asChild>
              <a href={wpAdminUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3 w-3 mr-1" />
                WordPress Order
              </a>
            </Button>
          )}
          {!wpAdminUrl && (
            <span className="text-sm text-muted-foreground">
              No WordPress URL configured in profile
            </span>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// --- Ingestions Tab ---

function IngestionsTab({
  orderId,
  orderCreatedAt,
  wordpressHost,
}: {
  orderId: string
  orderCreatedAt: string
  wordpressHost?: string
}) {
  const {
    data: ingestions,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['explorer', 'ingestions', orderId],
    queryFn: () => getOrderIngestions(orderId),
  })

  const columns: ColumnDef<ExplorerIngestion>[] = useMemo(() => {
    const getVerifyUrl = (code: string) => {
      const baseUrl = wordpressHost || 'https://accumarklabs.local'
      return `${baseUrl}/verify?code=${code}`
    }
    return [
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
          if (!code)
            return <span className="text-muted-foreground">{'\u2014'}</span>
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
          <span className="text-muted-foreground">
            {formatDate(row.original.completed_at)}
          </span>
        ),
      },
      {
        id: 'processing_time',
        header: 'Processing Time',
        size: 120,
        cell: ({ row }) => {
          const ing = row.original
          return (
            <span
              className={cn(
                'font-mono text-sm',
                ing.completed_at ? 'text-green-600' : 'text-yellow-600'
              )}
            >
              {formatProcessingTime(orderCreatedAt, ing.completed_at)}
            </span>
          )
        },
      },
      {
        id: 'actions',
        header: '',
        size: 80,
        cell: ({ row }) => {
          const ing = row.original
          if (ing.status !== 'uploaded' && ing.status !== 'notified')
            return null
          return (
            <DownloadCOAButton
              sampleId={ing.sample_id}
              version={ing.coa_version}
            />
          )
        },
      },
    ]
  }, [orderCreatedAt, wordpressHost])

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-4">
        <RefreshCw className="h-4 w-4 animate-spin" />
        Loading published COAs...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-destructive py-4">
        <AlertCircle className="h-4 w-4" />
        Failed to load published COAs
      </div>
    )
  }

  if (!ingestions || ingestions.length === 0) {
    return (
      <div className="text-muted-foreground py-4 text-center">
        No published COAs found for this order
      </div>
    )
  }

  return (
    <DataTable
      columns={columns}
      data={ingestions}
      getRowId={row => String(row.id)}
    />
  )
}

// --- Attempts Tab ---

function AttemptsTab({ orderId }: { orderId: string }) {
  const {
    data: attempts,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['explorer', 'attempts', orderId],
    queryFn: () => getOrderAttempts(orderId),
  })

  const columns: ColumnDef<ExplorerAttempt>[] = [
    {
      accessorKey: 'attempt_number',
      header: '#',
      size: 50,
      cell: ({ row }) => (
        <span className="font-mono">{row.original.attempt_number}</span>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      size: 100,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: 'error_message',
      header: 'Error',
      size: 200,
      cell: ({ row }) => {
        const msg = row.original.error_message
        if (!msg)
          return <span className="text-muted-foreground">{'\u2014'}</span>
        return <span className="text-destructive text-xs">{msg}</span>
      },
    },
    {
      id: 'samples_info',
      header: 'Samples',
      size: 150,
      cell: ({ row }) => {
        const sp = row.original.samples_processed
        if (!sp)
          return <span className="text-muted-foreground">{'\u2014'}</span>
        const processed = (sp.processed as string[])?.length ?? 0
        const created = (sp.created as string[])?.length ?? 0
        const failed = (sp.failed as string[])?.length ?? 0
        return (
          <span className="text-xs">
            {processed} processed, {created} created
            {failed > 0 && (
              <span className="text-destructive">, {failed} failed</span>
            )}
          </span>
        )
      },
    },
    {
      accessorKey: 'created_at',
      header: 'Timestamp',
      size: 130,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {formatDate(row.original.created_at)}
        </span>
      ),
    },
  ]

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-4">
        <RefreshCw className="h-4 w-4 animate-spin" />
        Loading attempts...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-destructive py-4">
        <AlertCircle className="h-4 w-4" />
        Failed to load attempts
      </div>
    )
  }

  if (!attempts || attempts.length === 0) {
    return (
      <div className="text-muted-foreground py-4 text-center">
        No submission attempts found
      </div>
    )
  }

  return (
    <DataTable
      columns={columns}
      data={attempts}
      getRowId={row => String(row.id)}
    />
  )
}

// --- COA Generations Tab ---

function COAGenerationsTab({
  orderId,
  wordpressHost,
}: {
  orderId: string
  wordpressHost?: string
}) {
  const {
    data: generations,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['explorer', 'coa-generations', orderId],
    queryFn: () => getOrderCOAGenerations(orderId),
  })

  const columns: ColumnDef<ExplorerCOAGeneration>[] = useMemo(() => {
    const getVerifyUrl = (code: string) => {
      const baseUrl = wordpressHost || 'https://accumarklabs.local'
      return `${baseUrl}/verify?code=${code}`
    }
    return [
      {
        accessorKey: 'sample_id',
        header: 'Sample ID',
        size: 100,
        cell: ({ row }) => (
          <span className="font-mono text-sm">{row.original.sample_id}</span>
        ),
      },
      {
        accessorKey: 'generation_number',
        header: 'Gen #',
        size: 60,
        cell: ({ row }) => (
          <span className="font-mono">#{row.original.generation_number}</span>
        ),
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
        size: 130,
        cell: ({ row }) => (
          <a
            href={getVerifyUrl(row.original.verification_code)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-sm text-primary hover:underline"
          >
            {row.original.verification_code}
          </a>
        ),
      },
      {
        accessorKey: 'anchor_status',
        header: 'Blockchain',
        size: 110,
        cell: ({ row }) => {
          const gen = row.original
          if (gen.anchor_status === 'anchored' && gen.anchor_tx_hash) {
            return (
              <Badge variant="default" className="gap-1 text-xs">
                <CheckCircle2 className="h-3 w-3" />
                Anchored
              </Badge>
            )
          }
          return <StatusBadge status={gen.anchor_status} />
        },
      },
      {
        accessorKey: 'content_hash',
        header: 'Hash',
        size: 100,
        cell: ({ row }) => (
          <span
            className="font-mono text-xs text-muted-foreground"
            title={row.original.content_hash}
          >
            {row.original.content_hash.slice(0, 12)}...
          </span>
        ),
      },
      {
        accessorKey: 'created_at',
        header: 'Created',
        size: 130,
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {formatDate(row.original.created_at)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        size: 140,
        cell: ({ row }) => {
          const gen = row.original
          return (
            <div className="flex items-center gap-1">
              {gen.status === 'published' && (
                <DownloadCOAButton
                  sampleId={gen.sample_id}
                  version={gen.generation_number}
                />
              )}
              {gen.chromatogram_s3_key && (
                <ViewChromatogramButton sampleId={gen.sample_id} />
              )}
            </div>
          )
        },
      },
    ]
  }, [wordpressHost])

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-4">
        <RefreshCw className="h-4 w-4 animate-spin" />
        Loading COA generations...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-destructive py-4">
        <AlertCircle className="h-4 w-4" />
        Failed to load COA generations
      </div>
    )
  }

  if (!generations || generations.length === 0) {
    return (
      <div className="text-muted-foreground py-4 text-center">
        No COA generations found
      </div>
    )
  }

  return (
    <DataTable
      columns={columns}
      data={generations}
      getRowId={row => String(row.id)}
    />
  )
}

// --- In Progress Tab ---

interface InProgressRow {
  id: string
  sample_name: string
  sample_identity: string
  lot_code: string
  senaite_id: string | null
  coa_status: 'awaiting_delivery' | 'delivered' | 'published'
}

function InProgressTab({
  orderId,
  payload,
  sampleResults,
  samplesExpected,
  samplesDelivered,
}: {
  orderId: string
  payload: Record<string, unknown> | null
  sampleResults: Record<string, { senaite_id: string; status: string }> | null
  samplesExpected: number
  samplesDelivered: number
}) {
  const {
    data: generations,
    isLoading,
  } = useQuery({
    queryKey: ['explorer', 'coa-generations', orderId],
    queryFn: () => getOrderCOAGenerations(orderId),
  })

  const rows = useMemo(() => {
    const payloadSamples = (
      payload?.samples as Array<{
        number: number
        sample_name: string
        sample_identity: string
        lot_code: string
      }> | undefined
    ) ?? []

    const publishedSampleIds = new Set(
      (generations ?? [])
        .filter(g => g.status === 'published')
        .map(g => g.sample_id)
    )

    // sample_results is keyed by sample number (e.g. "1", "2") with senaite_id
    const sampleResultsByNumber = new Map(
      Object.entries(sampleResults ?? {}).map(([key, val]) => [key, val])
    )

    const result: InProgressRow[] = []

    for (const ps of payloadSamples) {
      const sr = sampleResultsByNumber.get(String(ps.number))
      const senaiteId = sr?.senaite_id ?? null
      const isPublished = senaiteId ? publishedSampleIds.has(senaiteId) : false

      if (isPublished) continue

      result.push({
        id: `${orderId}-${ps.number}`,
        sample_name: ps.sample_name,
        sample_identity: ps.sample_identity,
        lot_code: ps.lot_code,
        senaite_id: senaiteId,
        coa_status: senaiteId ? 'delivered' : 'awaiting_delivery',
      })
    }

    return result
  }, [orderId, payload, sampleResults, generations])

  const columns: ColumnDef<InProgressRow>[] = [
    {
      accessorKey: 'senaite_id',
      header: 'Sample ID',
      size: 100,
      cell: ({ row }) => {
        const id = row.original.senaite_id
        if (!id) return <span className="text-muted-foreground">{'\u2014'}</span>
        return <span className="font-mono text-sm">{id}</span>
      },
    },
    {
      accessorKey: 'sample_name',
      header: 'Sample Name',
      size: 140,
    },
    {
      accessorKey: 'sample_identity',
      header: 'Identity',
      size: 120,
    },
    {
      accessorKey: 'lot_code',
      header: 'Lot Code',
      size: 100,
      cell: ({ row }) => (
        <span className="font-mono text-sm">{row.original.lot_code}</span>
      ),
    },
    {
      accessorKey: 'coa_status',
      header: 'Status',
      size: 140,
      cell: ({ row }) => {
        const status = row.original.coa_status
        if (status === 'awaiting_delivery') {
          return (
            <Badge variant="outline" className="gap-1 text-yellow-500 border-yellow-500/30">
              <Clock className="h-3 w-3" />
              Awaiting Delivery
            </Badge>
          )
        }
        return (
          <Badge variant="secondary" className="gap-1">
            <RefreshCw className="h-3 w-3" />
            Awaiting COA
          </Badge>
        )
      },
    },
  ]

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-4">
        <RefreshCw className="h-4 w-4 animate-spin" />
        Loading...
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground py-4 text-center">
        All samples have published COAs
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        {samplesDelivered}/{samplesExpected} samples delivered
      </div>
      <DataTable
        columns={columns}
        data={rows}
        getRowId={row => row.id}
      />
    </div>
  )
}

// --- Sample Events Tab ---

function SampleEventsTab({ orderId }: { orderId: string }) {
  const {
    data: events,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['explorer', 'sample-events', orderId],
    queryFn: () => getOrderSampleEvents(orderId),
  })

  const columns: ColumnDef<ExplorerSampleEvent>[] = [
    {
      accessorKey: 'sample_id',
      header: 'Sample ID',
      size: 100,
      cell: ({ row }) => (
        <span className="font-mono text-sm">{row.original.sample_id}</span>
      ),
    },
    {
      accessorKey: 'transition',
      header: 'Transition',
      size: 100,
      cell: ({ row }) => (
        <Badge variant="outline">{row.original.transition}</Badge>
      ),
    },
    {
      accessorKey: 'new_status',
      header: 'New Status',
      size: 140,
      cell: ({ row }) => (
        <span className="text-sm">{row.original.new_status}</span>
      ),
    },
    {
      id: 'wp_notification',
      header: 'WP Notified',
      size: 100,
      cell: ({ row }) => {
        const event = row.original
        if (event.wp_notified) {
          return (
            <Badge variant="default" className="gap-1 text-xs">
              <CheckCircle2 className="h-3 w-3" />
              {event.wp_status_sent || 'Yes'}
            </Badge>
          )
        }
        if (event.wp_error) {
          return (
            <Badge variant="destructive" className="gap-1 text-xs">
              <XCircle className="h-3 w-3" />
              Error
            </Badge>
          )
        }
        return <span className="text-muted-foreground">{'\u2014'}</span>
      },
    },
    {
      accessorKey: 'created_at',
      header: 'Timestamp',
      size: 130,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {formatDate(row.original.created_at)}
        </span>
      ),
    },
  ]

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-4">
        <RefreshCw className="h-4 w-4 animate-spin" />
        Loading sample events...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-destructive py-4">
        <AlertCircle className="h-4 w-4" />
        Failed to load sample events
      </div>
    )
  }

  if (!events || events.length === 0) {
    return (
      <div className="text-muted-foreground py-4 text-center">
        No sample events found
      </div>
    )
  }

  return (
    <DataTable
      columns={columns}
      data={events}
      getRowId={row => String(row.id)}
    />
  )
}

// --- Access Logs Tab ---

function AccessLogsTab({ orderId }: { orderId: string }) {
  const {
    data: logs,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['explorer', 'access-logs', orderId],
    queryFn: () => getOrderAccessLogs(orderId),
  })

  const columns: ColumnDef<ExplorerAccessLog>[] = [
    {
      accessorKey: 'sample_id',
      header: 'Sample ID',
      size: 100,
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
      accessorKey: 'action',
      header: 'Action',
      size: 130,
      cell: ({ row }) => {
        const action = row.original.action
        const icons: Record<string, React.ReactNode> = {
          download: <Download className="h-3 w-3" />,
          desktop_download: <Download className="h-3 w-3" />,
          verify: <Shield className="h-3 w-3" />,
          view: <Eye className="h-3 w-3" />,
        }
        return (
          <Badge variant="outline" className="gap-1 text-xs">
            {icons[action] || <FileText className="h-3 w-3" />}
            {action}
          </Badge>
        )
      },
    },
    {
      accessorKey: 'requester_ip',
      header: 'IP Address',
      size: 120,
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">
          {row.original.requester_ip || '\u2014'}
        </span>
      ),
    },
    {
      accessorKey: 'requested_by',
      header: 'Requested By',
      size: 120,
      cell: ({ row }) => (
        <span className="text-sm">
          {row.original.requested_by || '\u2014'}
        </span>
      ),
    },
    {
      accessorKey: 'timestamp',
      header: 'Timestamp',
      size: 130,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {formatDate(row.original.timestamp)}
        </span>
      ),
    },
  ]

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-4">
        <RefreshCw className="h-4 w-4 animate-spin" />
        Loading access logs...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-destructive py-4">
        <AlertCircle className="h-4 w-4" />
        Failed to load access logs
      </div>
    )
  }

  if (!logs || logs.length === 0) {
    return (
      <div className="text-muted-foreground py-4 text-center">
        No access logs found for this order
      </div>
    )
  }

  return (
    <DataTable
      columns={columns}
      data={logs}
      getRowId={row => String(row.id)}
    />
  )
}

// --- Main Panel ---

interface OrderDetailPanelProps {
  order: ExplorerOrder
  wordpressHost?: string
  onClose: () => void
  onViewPayload: (order: ExplorerOrder) => void
}

export function OrderDetailPanel({
  order,
  wordpressHost,
  onClose,
  onViewPayload,
}: OrderDetailPanelProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">
              Order #{order.order_id}
              <span className="text-muted-foreground font-normal ml-2">
                ({order.order_number})
              </span>
            </CardTitle>
            <CardDescription className="flex items-center gap-2 mt-1">
              <StatusBadge status={order.status} />
              <span>
                {order.samples_delivered}/{order.samples_expected} samples
              </span>
              <span>{'\u2022'}</span>
              <span>{formatDate(order.created_at)}</span>
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {order.payload && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onViewPayload(order)}
              >
                View Payload
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="summary">
          <TabsList>
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="in-progress">In Progress</TabsTrigger>
            <TabsTrigger value="ingestions">COAs Published</TabsTrigger>
            <TabsTrigger value="coa-generations">COA Generations</TabsTrigger>
            <TabsTrigger value="attempts">Attempts</TabsTrigger>
            <TabsTrigger value="sample-events">Sample Events</TabsTrigger>
            <TabsTrigger value="access-logs">Access Logs</TabsTrigger>
          </TabsList>
          <TabsContent value="summary" className="mt-4">
            <SummaryTab order={order} wordpressHost={wordpressHost} />
          </TabsContent>
          <TabsContent value="in-progress" className="mt-4">
            <InProgressTab
              orderId={order.order_id}
              payload={order.payload}
              sampleResults={order.sample_results}
              samplesExpected={order.samples_expected}
              samplesDelivered={order.samples_delivered}
            />
          </TabsContent>
          <TabsContent value="ingestions" className="mt-4">
            <IngestionsTab
              orderId={order.order_id}
              orderCreatedAt={order.created_at}
              wordpressHost={wordpressHost}
            />
          </TabsContent>
          <TabsContent value="coa-generations" className="mt-4">
            <COAGenerationsTab
              orderId={order.order_id}
              wordpressHost={wordpressHost}
            />
          </TabsContent>
          <TabsContent value="attempts" className="mt-4">
            <AttemptsTab orderId={order.order_id} />
          </TabsContent>
          <TabsContent value="sample-events" className="mt-4">
            <SampleEventsTab orderId={order.order_id} />
          </TabsContent>
          <TabsContent value="access-logs" className="mt-4">
            <AccessLogsTab orderId={order.order_id} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
