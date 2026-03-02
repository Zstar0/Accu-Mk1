import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  RefreshCw,
  XCircle,
  Loader2,
  FlaskConical,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  X,
  ChevronLeft,
  Filter,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  getSenaiteSamples,
  getSenaiteStatus,
  type SenaiteSample,
} from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { StateBadge, formatDate } from '@/components/senaite/senaite-utils'

// --- Constants ---

interface Tab {
  id: string
  label: string
  reviewState: string | undefined
  description: string
}

const TABS: Tab[] = [
  {
    id: 'open',
    label: 'All Open',
    reviewState:
      'sample_registered,sample_due,sample_received,to_be_verified,verified,waiting_for_addon_results,ready_for_review',
    description: 'All active samples not yet published',
  },
  {
    id: 'received',
    label: 'Received',
    reviewState: 'sample_received',
    description: 'Samples received and ready for analysis',
  },
  {
    id: 'waiting_for_addon',
    label: 'Waiting for Addon',
    reviewState: 'waiting_for_addon_results',
    description: 'Awaiting add-on test results',
  },
  {
    id: 'ready_for_review',
    label: 'Ready for Review',
    reviewState: 'ready_for_review',
    description: 'Add-on results in — ready for review',
  },
  {
    id: 'to_be_verified',
    label: 'To Verify',
    reviewState: 'to_be_verified',
    description: 'Analyses complete — awaiting verification',
  },
  {
    id: 'verified',
    label: 'Verified',
    reviewState: 'verified',
    description: 'Verified — ready to publish',
  },
  {
    id: 'published',
    label: 'Published',
    reviewState: 'published',
    description: 'COA published and dispatched',
  },
]

// --- Column sorting ---

type SortColumn =
  | 'id'
  | 'client_order_number'
  | 'client_id'
  | 'verification_code'
  | 'date_created'
  | 'review_state'
type SortDirection = 'asc' | 'desc'

interface SortConfig {
  column: SortColumn
  direction: SortDirection
}

function compareSamples(
  a: SenaiteSample,
  b: SenaiteSample,
  config: SortConfig
): number {
  const { column, direction } = config
  let cmp = 0

  if (column === 'date_created') {
    const da = a.date_created ? new Date(a.date_created).getTime() : 0
    const db = b.date_created ? new Date(b.date_created).getTime() : 0
    cmp = da - db
  } else {
    const va = (a[column] ?? '').toLowerCase()
    const vb = (b[column] ?? '').toLowerCase()
    cmp = va.localeCompare(vb, undefined, { numeric: true })
  }

  return direction === 'desc' ? -cmp : cmp
}

function SortIcon({ column, sort }: { column: SortColumn; sort: SortConfig }) {
  if (sort.column !== column) {
    return <ArrowUpDown className="h-3 w-3 text-muted-foreground/50" />
  }
  return sort.direction === 'asc' ? (
    <ArrowUp className="h-3 w-3" />
  ) : (
    <ArrowDown className="h-3 w-3" />
  )
}

// --- Sample Table ---

const TEST_CLIENT_ID = 'forrest@valenceanalytical.com'

interface ColumnFilters {
  id: string
  client_order_number: string
  verification_code: string
}

function SampleTable({
  samples,
  loading,
  connected,
  error,
  hideTestSamples,
  onSelectSample,
  columnFilters,
  onColumnFilterChange,
}: {
  samples: SenaiteSample[]
  loading: boolean
  connected: boolean
  error: string | null
  hideTestSamples: boolean
  onSelectSample?: (sampleId: string) => void
  columnFilters: ColumnFilters
  onColumnFilterChange: (column: keyof ColumnFilters, value: string) => void
}) {
  const navigateToOrderExplorer = useUIStore(
    state => state.navigateToOrderExplorer
  )
  const [sort, setSort] = useState<SortConfig>({
    column: 'date_created',
    direction: 'desc',
  })

  const toggleSort = (column: SortColumn) => {
    setSort(prev =>
      prev.column === column
        ? { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' }
    )
  }

  // Client-side filtering: only hide test samples (column searches are now server-side)
  const filteredSamples = useMemo(() => {
    let result = samples
    if (hideTestSamples) {
      result = result.filter(s => s.client_id?.toLowerCase() !== TEST_CLIENT_ID)
    }
    return result
  }, [samples, hideTestSamples])

  const sortedSamples = useMemo(() => {
    return [...filteredSamples].sort((a, b) => compareSamples(a, b, sort))
  }, [filteredSamples, sort])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
        <XCircle className="h-6 w-6" />
        <p className="text-sm">{error ?? 'SENAITE not connected'}</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
        <XCircle className="h-6 w-6" />
        <p className="text-sm">{error}</p>
      </div>
    )
  }

  if (samples.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
        <FlaskConical className="h-6 w-6" />
        <p className="text-sm">No samples found</p>
      </div>
    )
  }

  const columns: {
    key: SortColumn
    label: string
    className: string
    cellClassName: string
  }[] = [
    {
      key: 'id',
      label: 'Sample ID',
      className: 'w-32',
      cellClassName: 'font-mono text-sm',
    },
    {
      key: 'client_order_number',
      label: 'Order #',
      className: 'w-36',
      cellClassName: 'text-sm text-muted-foreground',
    },
    {
      key: 'client_id',
      label: 'Client',
      className: '',
      cellClassName: 'text-sm',
    },
    {
      key: 'verification_code',
      label: 'Verification Code',
      className: 'w-36',
      cellClassName: 'font-mono text-sm text-muted-foreground',
    },
    {
      key: 'date_created',
      label: 'Created',
      className: 'w-36',
      cellClassName: 'text-sm text-muted-foreground',
    },
    {
      key: 'review_state',
      label: 'State',
      className: 'w-28 text-center',
      cellClassName: 'text-center',
    },
  ]

  // Columns that support inline search
  const filterableColumns: (keyof ColumnFilters)[] = ['id', 'client_order_number', 'verification_code']

  return (
    <div className="overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map(col => (
              <TableHead
                key={col.key}
                className={`${col.className} cursor-pointer select-none hover:text-foreground transition-colors`}
                onClick={() => toggleSort(col.key)}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  <SortIcon column={col.key} sort={sort} />
                </span>
              </TableHead>
            ))}
          </TableRow>
          {/* Per-column filter inputs */}
          <TableRow className="border-b-0 hover:bg-transparent">
            {columns.map(col => (
              <TableHead key={`filter-${col.key}`} className={`${col.className} py-1 px-2`}>
                {filterableColumns.includes(col.key as keyof ColumnFilters) ? (
                  <div className="relative">
                    <Filter className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50 pointer-events-none" />
                    <input
                      value={columnFilters[col.key as keyof ColumnFilters]}
                      onChange={e => onColumnFilterChange(col.key as keyof ColumnFilters, e.target.value)}
                      placeholder={`Search…`}
                      className="w-full h-6 pl-5 pr-1 text-xs bg-muted/30 border border-border/30 rounded focus:outline-none focus:ring-1 focus:ring-ring/50"
                      onClick={e => e.stopPropagation()}
                    />
                  </div>
                ) : null}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedSamples.map(s => (
            <TableRow
              key={s.uid}
              className="hover:bg-muted/30 cursor-pointer"
              onClick={() => onSelectSample?.(s.id)}
            >
              <TableCell className="font-mono text-sm">{s.id}</TableCell>
              <TableCell className="text-sm">
                {s.client_order_number ? (
                  <button
                    type="button"
                    className="text-blue-400 hover:text-blue-300 hover:underline transition-colors"
                    onClick={e => {
                      e.stopPropagation()
                      // SENAITE stores "WP-1234" but the DB stores just "1234"
                      const orderNum = s.client_order_number!.replace(
                        /^WP-/i,
                        ''
                      )
                      navigateToOrderExplorer(orderNum)
                    }}
                  >
                    {s.client_order_number}
                  </button>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-sm">{s.client_id ?? '—'}</TableCell>
              <TableCell className="font-mono text-sm text-muted-foreground">
                {s.verification_code ?? '—'}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatDate(s.date_created)}
              </TableCell>
              <TableCell className="text-center">
                <StateBadge state={s.review_state} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// --- Main Dashboard ---

const PAGE_SIZE = 25

export function SenaiteDashboard() {
  const navigateToSample = useUIStore(state => state.navigateToSample)
  const [activeTab, setActiveTab] = useState('open')
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [samplesByTab, setSamplesByTab] = useState<
    Record<string, SenaiteSample[]>
  >({})
  const [totalsByTab, setTotalsByTab] = useState<Record<string, number>>({})
  const [pageByTab, setPageByTab] = useState<Record<string, number>>({})
  // sampleIdSearch is now managed inside columnFilters.id
  const [hideTestSamples, setHideTestSamples] = useState(true)
  const [searchResults, setSearchResults] = useState<SenaiteSample[] | null>(
    null
  )
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )
  const [columnFilters, setColumnFilters] = useState<ColumnFilters>({
    id: '',
    client_order_number: '',
    verification_code: '',
  })
  const handleColumnFilterChange = useCallback((column: keyof ColumnFilters, value: string) => {
    setColumnFilters(prev => ({ ...prev, [column]: value }))
  }, [])
  // Alias for backward compat with search logic
  const sampleIdSearch = columnFilters.id

  const loadTab = useCallback(
    async (tabId: string, _page = 0, searchQuery = '', searchField?: 'verification_code' | 'order_number') => {
      const tab = TABS.find(t => t.id === tabId)
      if (!tab) return

      setLoading(true)
      setError(null)
      try {
        if (searchQuery) {
          // Server-side search:
          // - no searchField: Uses SENAITE's getId catalog index (sample ID)
          // - verification_code: Postgres lookup → sample IDs → SENAITE getId
          // - order_number: Postgres lookup → sample IDs → SENAITE getId
          const result = await getSenaiteSamples(undefined, 50, 0, searchQuery, searchField)
          setSearchResults(result.items)
        } else {
          setSearchResults(null)
          const result = await getSenaiteSamples(
            tab.reviewState,
            PAGE_SIZE,
            _page * PAGE_SIZE
          )
          setSamplesByTab(prev => ({ ...prev, [tabId]: result.items }))
          setTotalsByTab(prev => ({ ...prev, [tabId]: result.total }))
          setPageByTab(prev => ({ ...prev, [tabId]: _page }))
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load samples')
      } finally {
        setLoading(false)
      }
    },
    []
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    setSamplesByTab({})
    setTotalsByTab({})
    setPageByTab({})
    try {
      const status = await getSenaiteStatus()
      setConnected(status.enabled)
      if (status.enabled) {
        await loadTab(activeTab, 0)
      }
    } catch {
      setConnected(false)
      setError('Could not reach SENAITE')
    } finally {
      setLoading(false)
    }
  }, [activeTab, loadTab])

  // Initial load
  useEffect(() => {
    let cancelled = false
    async function init() {
      setLoading(true)
      try {
        const status = await getSenaiteStatus()
        if (cancelled) return
        setConnected(status.enabled)
        if (status.enabled) {
          const tab = TABS.find(t => t.id === activeTab)!
          const result = await getSenaiteSamples(tab.reviewState, PAGE_SIZE, 0)
          if (cancelled) return
          setSamplesByTab({ [activeTab]: result.items })
          setTotalsByTab({ [activeTab]: result.total })
          setPageByTab({ [activeTab]: 0 })
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : 'Failed to connect')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    init()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced server-side search — fires on any column filter change
  useEffect(() => {
    if (!connected) return
    clearTimeout(searchTimerRef.current)

    // Determine which filter is active (priority: id > order > verification)
    const idQ = columnFilters.id.trim()
    const orderQ = columnFilters.client_order_number.trim()
    const verQ = columnFilters.verification_code.trim()

    if (!idQ && !orderQ && !verQ) {
      // No filters active — reload normal tab data
      loadTab(activeTab, 0)
      return
    }

    searchTimerRef.current = setTimeout(() => {
      if (idQ) {
        loadTab(activeTab, 0, idQ)  // default: getId catalog
      } else if (orderQ) {
        loadTab(activeTab, 0, orderQ, 'order_number')
      } else if (verQ) {
        loadTab(activeTab, 0, verQ, 'verification_code')
      }
    }, 350)
    return () => clearTimeout(searchTimerRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnFilters])

  const handleTabChange = (tabId: string) => {
    setActiveTab(tabId)
    if (connected) loadTab(tabId, 0, sampleIdSearch.trim())
  }

  const isSearching = searchResults !== null
  const currentSamples = isSearching
    ? searchResults
    : (samplesByTab[activeTab] ?? [])
  const currentTotal = isSearching
    ? searchResults.length
    : (totalsByTab[activeTab] ?? 0)
  const currentPage = pageByTab[activeTab] ?? 0
  const totalPages = Math.ceil((totalsByTab[activeTab] ?? 0) / PAGE_SIZE)
  const currentTab = TABS.find(t => t.id === activeTab)!
  const hasActiveFilters = sampleIdSearch.trim() !== '' || columnFilters.client_order_number !== '' || columnFilters.verification_code !== ''

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">SENAITE</h1>
            <p className="text-muted-foreground">
              Sample tracking and workflow status
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={refresh}
            className="h-8 w-8"
            title="Refresh"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
            />
          </Button>
        </div>

        {/* Samples Card with Tabs */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <FlaskConical className="h-4 w-4 text-blue-500" />
                  Open Samples
                </CardTitle>
                <CardDescription>
                  {!connected
                    ? 'Connect to SENAITE to view samples'
                    : loading && sampleIdSearch.trim()
                      ? `Searching for "${sampleIdSearch.trim()}"…`
                      : isSearching
                        ? currentTotal > 0
                          ? `${currentTotal} result${currentTotal !== 1 ? 's' : ''} for "${sampleIdSearch.trim()}"`
                          : `No results for "${sampleIdSearch.trim()}"`
                        : !loading && currentTotal > 0
                          ? `${currentTotal} sample${currentTotal !== 1 ? 's' : ''} — ${currentTab.description}`
                          : currentTab.description}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                {connected && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs gap-1"
                    onClick={() =>
                      window.open(`${window.location.origin}`, '_blank')
                    }
                  >
                    Open SENAITE
                    <ChevronRight className="h-3 w-3" />
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex items-center gap-3 mb-4">
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1 text-muted-foreground"
                  onClick={() => {
                    setColumnFilters({ id: '', client_order_number: '', verification_code: '' })
                  }}
                >
                  <X className="h-3 w-3" />
                  Clear all searches
                </Button>
              )}
              <div className="flex-1" />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={hideTestSamples}
                  onChange={e => setHideTestSamples(e.target.checked)}
                  className="cursor-pointer"
                />
                Hide test samples
              </label>
            </div>
            <Tabs value={activeTab} onValueChange={handleTabChange}>
              <TabsList className="mb-4">
                {TABS.map(tab => (
                  <TabsTrigger key={tab.id} value={tab.id} className="text-xs">
                    {tab.label}
                    {(totalsByTab[tab.id] ?? 0) > 0 && (
                      <Badge
                        variant="secondary"
                        className="ml-1.5 h-4 px-1.5 text-[10px]"
                      >
                        {totalsByTab[tab.id]}
                      </Badge>
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
              {TABS.map(tab => (
                <TabsContent key={tab.id} value={tab.id} className="mt-0">
                  <SampleTable
                    samples={activeTab === tab.id ? currentSamples : []}
                    loading={loading && activeTab === tab.id}
                    connected={connected}
                    error={error}
                    hideTestSamples={hideTestSamples}
                    onSelectSample={navigateToSample}
                    columnFilters={columnFilters}
                    onColumnFilterChange={handleColumnFilterChange}
                  />
                </TabsContent>
              ))}
            </Tabs>
            {connected && !loading && totalPages > 1 && !isSearching && (
              <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/30">
                <span className="text-xs text-muted-foreground">
                  {currentPage * PAGE_SIZE + 1}–
                  {Math.min((currentPage + 1) * PAGE_SIZE, currentTotal)} of{' '}
                  {currentTotal}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={currentPage === 0}
                    onClick={() => loadTab(activeTab, currentPage - 1)}
                    className="h-7 w-7 p-0 cursor-pointer"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <span className="text-xs text-muted-foreground px-2">
                    {currentPage + 1} / {totalPages}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={currentPage >= totalPages - 1}
                    onClick={() => loadTab(activeTab, currentPage + 1)}
                    className="h-7 w-7 p-0 cursor-pointer"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  )
}
