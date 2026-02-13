import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Search,
  FileCheck,
  RefreshCw,
  ChevronRight,
  ChevronLeft,
  AlertCircle,
  CheckCircle2,
  Clock,
  XCircle,
  ExternalLink,
  Download,
  Image,
} from 'lucide-react'
import type { ColumnDef } from '@tanstack/react-table'

import { cn } from '@/lib/utils'
import {
  getExplorerStatus,
  getExplorerCOAGenerations,
  getExplorerCOASignedUrl,
  getExplorerChromatogramSignedUrl,
  type ExplorerCOAGeneration,
} from '@/lib/api'
import {
  getActiveEnvironmentName,
  getWordpressUrl,
  API_PROFILE_CHANGED_EVENT,
} from '@/lib/api-profiles'
import { useUIStore } from '@/store/ui-store'

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

// --- Helpers ---

function StatusBadge({ status }: { status: string }) {
  const variants: Record<
    string,
    {
      variant: 'default' | 'secondary' | 'destructive' | 'outline'
      icon: React.ReactNode
    }
  > = {
    draft: { variant: 'secondary', icon: <Clock className="h-3 w-3" /> },
    published: {
      variant: 'default',
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    superseded: {
      variant: 'outline',
      icon: <XCircle className="h-3 w-3" />,
    },
    pending: { variant: 'secondary', icon: <Clock className="h-3 w-3" /> },
    confirming: {
      variant: 'secondary',
      icon: <RefreshCw className="h-3 w-3 animate-spin" />,
    },
    anchored: {
      variant: 'default',
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    failed: { variant: 'destructive', icon: <XCircle className="h-3 w-3" /> },
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
      onClick={(e) => { e.stopPropagation(); handleDownload() }}
      disabled={loading}
      title="Download COA PDF"
    >
      {loading ? (
        <RefreshCw className="h-3 w-3 animate-spin" />
      ) : (
        <Download className="h-3 w-3" />
      )}
      PDF
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
      onClick={(e) => { e.stopPropagation(); handleView() }}
      disabled={loading}
      title="View Chromatogram"
    >
      {loading ? (
        <RefreshCw className="h-3 w-3 animate-spin" />
      ) : (
        <Image className="h-3 w-3" />
      )}
      Chrom
    </Button>
  )
}

const PAGE_SIZE = 50

const STATUS_OPTIONS = [
  { value: 'all', label: 'All Statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'superseded', label: 'Superseded' },
]

const ANCHOR_STATUS_OPTIONS = [
  { value: 'all', label: 'All Blockchain' },
  { value: 'pending', label: 'Pending' },
  { value: 'confirming', label: 'Confirming' },
  { value: 'anchored', label: 'Anchored' },
  { value: 'failed', label: 'Failed' },
]

/**
 * COA Explorer - Top-level view of all COA generations across all orders.
 */
export function COAExplorer() {
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [anchorStatusFilter, setAnchorStatusFilter] = useState('all')
  const [page, setPage] = useState(0)

  const navigateToOrderExplorer = useUIStore(state => state.navigateToOrderExplorer)

  // Track the current environment name for display
  const [envName, setEnvName] = useState(() => getActiveEnvironmentName())

  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshSuccess, setRefreshSuccess] = useState(false)
  const queryClient = useQueryClient()

  // Listen for environment changes (admin override)
  useEffect(() => {
    const handleProfileChange = () => {
      setEnvName(getActiveEnvironmentName())
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
    queryKey: ['explorer', 'status', envName],
    queryFn: getExplorerStatus,
    staleTime: 0,
  })

  // COA generations query
  const {
    data: generations,
    isLoading: generationsLoading,
    error: generationsError,
  } = useQuery({
    queryKey: [
      'explorer',
      'coa-generations-all',
      debouncedSearch,
      statusFilter,
      anchorStatusFilter,
      page,
      envName,
    ],
    queryFn: () =>
      getExplorerCOAGenerations(
        debouncedSearch || undefined,
        PAGE_SIZE,
        page * PAGE_SIZE,
        statusFilter === 'all' ? undefined : statusFilter,
        anchorStatusFilter === 'all' ? undefined : anchorStatusFilter
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

  const handleAnchorStatusFilterChange = (value: string) => {
    setAnchorStatusFilter(value)
    setPage(0)
  }

  const handleRefresh = async () => {
    setIsRefreshing(true)
    setRefreshSuccess(false)
    await queryClient.invalidateQueries({ queryKey: ['explorer'] })
    setIsRefreshing(false)
    setRefreshSuccess(true)
  }

  const handleOrderClick = (orderId: string) => {
    navigateToOrderExplorer(orderId)
  }

  // Get WordPress host for verification links
  const wordpressHost = getWordpressUrl() || 'https://accumarklabs.local'

  // Column definitions
  const columns: ColumnDef<ExplorerCOAGeneration>[] = [
    {
      accessorKey: 'sample_id',
      header: 'Sample ID',
      size: 110,
      enableSorting: true,
      cell: ({ row }) => (
        <span className="font-mono text-sm">{row.original.sample_id}</span>
      ),
    },
    {
      accessorKey: 'generation_number',
      header: 'Gen #',
      size: 60,
      enableSorting: true,
      cell: ({ row }) => (
        <span className="font-mono">#{row.original.generation_number}</span>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      size: 100,
      enableSorting: true,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: 'verification_code',
      header: 'Verification Code',
      size: 140,
      enableSorting: false,
      cell: ({ row }) => (
        <a
          href={`${wordpressHost}/verify?code=${row.original.verification_code}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-sm text-primary hover:underline"
          onClick={e => e.stopPropagation()}
        >
          {row.original.verification_code}
        </a>
      ),
    },
    {
      accessorKey: 'anchor_status',
      header: 'Blockchain',
      size: 110,
      enableSorting: true,
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
      enableSorting: false,
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
      id: 'order',
      header: 'Order',
      size: 100,
      enableSorting: false,
      cell: ({ row }) => {
        const gen = row.original
        if (!gen.order_id && !gen.order_number) {
          return <span className="text-muted-foreground">{'\u2014'}</span>
        }
        return (
          <button
            type="button"
            className="flex items-center gap-1 text-sm text-primary hover:underline"
            onClick={e => {
              e.stopPropagation()
              if (gen.order_id) handleOrderClick(gen.order_id)
            }}
          >
            {gen.order_number || gen.order_id}
            <ExternalLink className="h-3 w-3" />
          </button>
        )
      },
    },
    {
      accessorKey: 'created_at',
      header: 'Created',
      size: 130,
      enableSorting: true,
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
      enableSorting: false,
      enableResizing: false,
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
    {
      id: 'chevron',
      header: '',
      size: 32,
      enableSorting: false,
      enableResizing: false,
      cell: ({ row }) =>
        row.original.order_id ? (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        ) : null,
    },
  ]

  const hasNextPage = generations && generations.length === PAGE_SIZE
  const hasPrevPage = page > 0

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <FileCheck className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-semibold">COA Explorer</h2>
            <p className="text-sm text-muted-foreground">
              Browse all COA generations across all orders
            </p>
          </div>
        </div>

        {/* Status and refresh */}
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="text-xs">
            {envName}
          </Badge>

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
                (isRefreshing || generationsLoading) && 'animate-spin'
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

      {/* Search and filters */}
      {status?.connected && (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by Sample ID..."
              value={searchTerm}
              onChange={e => handleSearchChange(e.target.value)}
              className="pl-10"
            />
          </div>
          <select
            value={statusFilter}
            onChange={e => handleStatusFilterChange(e.target.value)}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            {STATUS_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <select
            value={anchorStatusFilter}
            onChange={e => handleAnchorStatusFilterChange(e.target.value)}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            {ANCHOR_STATUS_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* COA Generations table */}
      {status?.connected && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">COA Generations</CardTitle>
                <CardDescription>
                  {generations
                    ? `${generations.length} generations${generations.length === PAGE_SIZE ? '+' : ''}`
                    : 'Loading...'}
                  {statusFilter !== 'all' && ` (status: ${statusFilter})`}
                  {anchorStatusFilter !== 'all' &&
                    ` (blockchain: ${anchorStatusFilter})`}
                  . Click a row to view its order.
                </CardDescription>
              </div>
              {/* Pagination */}
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => p - 1)}
                  disabled={!hasPrevPage || generationsLoading}
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
                  disabled={!hasNextPage || generationsLoading}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {generationsLoading && (
              <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Loading COA generations...
              </div>
            )}

            {generationsError && (
              <div className="flex items-center gap-2 text-destructive py-8 justify-center">
                <AlertCircle className="h-4 w-4" />
                Failed to load COA generations
              </div>
            )}

            {generations && generations.length === 0 && !generationsLoading && (
              <div className="text-muted-foreground py-8 text-center">
                {debouncedSearch
                  ? 'No COA generations match your search'
                  : 'No COA generations found'}
              </div>
            )}

            {generations && generations.length > 0 && (
              <div className="max-h-[500px] overflow-auto">
                <DataTable
                  columns={columns}
                  data={generations}
                  onRowClick={row => {
                    if (row.order_id) handleOrderClick(row.order_id)
                  }}
                  getRowId={row => row.id}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
