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
  Search,
  X,
  ChevronLeft,
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
import { getSenaiteSamples, getSenaiteStatus, type SenaiteSample } from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { StateBadge, formatDate } from '@/components/senaite/senaite-utils'
import { Input } from '@/components/ui/input'

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
    reviewState: 'sample_registered,sample_due,sample_received,to_be_verified,verified,waiting_for_addon_results,ready_for_review',
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

type SortColumn = 'id' | 'client_order_number' | 'client_id' | 'verification_code' | 'date_created' | 'review_state'
type SortDirection = 'asc' | 'desc'

interface SortConfig {
  column: SortColumn
  direction: SortDirection
}

function compareSamples(a: SenaiteSample, b: SenaiteSample, config: SortConfig): number {
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
  return sort.direction === 'asc'
    ? <ArrowUp className="h-3 w-3" />
    : <ArrowDown className="h-3 w-3" />
}

// --- Sample Table ---

const TEST_CLIENT_ID = 'forrest@valenceanalytical.com'

function SampleTable({
  samples,
  loading,
  connected,
  error,
  hideTestSamples,
  onSelectSample,
}: {
  samples: SenaiteSample[]
  loading: boolean
  connected: boolean
  error: string | null
  hideTestSamples: boolean
  onSelectSample?: (sampleId: string) => void
}) {
  const navigateToOrderExplorer = useUIStore(state => state.navigateToOrderExplorer)
  const [sort, setSort] = useState<SortConfig>({ column: 'date_created', direction: 'desc' })

  const toggleSort = (column: SortColumn) => {
    setSort(prev =>
      prev.column === column
        ? { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' }
    )
  }

  const filteredSamples = useMemo(() => {
    if (!hideTestSamples) return samples
    return samples.filter(s => s.client_id?.toLowerCase() !== TEST_CLIENT_ID)
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

  const columns: { key: SortColumn; label: string; className: string; cellClassName: string }[] = [
    { key: 'id', label: 'Sample ID', className: 'w-32', cellClassName: 'font-mono text-sm' },
    { key: 'client_order_number', label: 'Order #', className: 'w-36', cellClassName: 'text-sm text-muted-foreground' },
    { key: 'client_id', label: 'Client', className: '', cellClassName: 'text-sm' },
    { key: 'verification_code', label: 'Verification Code', className: 'w-36', cellClassName: 'font-mono text-sm text-muted-foreground' },
    { key: 'date_created', label: 'Created', className: 'w-36', cellClassName: 'text-sm text-muted-foreground' },
    { key: 'review_state', label: 'State', className: 'w-28 text-center', cellClassName: 'text-center' },
  ]

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
                      const orderNum = s.client_order_number!.replace(/^WP-/i, '')
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
              <TableCell className="font-mono text-sm text-muted-foreground">{s.verification_code ?? '—'}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{formatDate(s.date_created)}</TableCell>
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
  const [samplesByTab, setSamplesByTab] = useState<Record<string, SenaiteSample[]>>({})
  const [totalsByTab, setTotalsByTab] = useState<Record<string, number>>({})
  const [pageByTab, setPageByTab] = useState<Record<string, number>>({})
  const [search, setSearch] = useState('')
  const [hideTestSamples, setHideTestSamples] = useState(true)
  const [searchResults, setSearchResults] = useState<SenaiteSample[] | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const loadTab = useCallback(async (tabId: string, page = 0, searchQuery = '') => {
    const tab = TABS.find(t => t.id === tabId)
    if (!tab) return

    setLoading(true)
    setError(null)
    try {
      if (searchQuery) {
        // Fetch up to 500 items across ALL states and filter client-side.
        // reviewState is intentionally omitted so published samples are also found.
        const result = await getSenaiteSamples(undefined, 500, 0)
        const q = searchQuery.toLowerCase()
        const filtered = result.items.filter(s =>
          s.id.toLowerCase().includes(q) ||
          (s.verification_code?.toLowerCase() ?? '').includes(q) ||
          (s.client_order_number?.toLowerCase() ?? '').includes(q) ||
          (s.client_id?.toLowerCase() ?? '').includes(q)
        )
        setSearchResults(filtered)
      } else {
        setSearchResults(null)
        const result = await getSenaiteSamples(tab.reviewState, PAGE_SIZE, page * PAGE_SIZE)
        setSamplesByTab(prev => ({ ...prev, [tabId]: result.items }))
        setTotalsByTab(prev => ({ ...prev, [tabId]: result.total }))
        setPageByTab(prev => ({ ...prev, [tabId]: page }))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load samples')
    } finally {
      setLoading(false)
    }
  }, [])

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
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to connect')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    init()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced server-side search — fires on every search change
  useEffect(() => {
    if (!connected) return
    clearTimeout(searchTimerRef.current)
    const q = search.trim()
    if (!q) {
      loadTab(activeTab, 0)
      return
    }
    searchTimerRef.current = setTimeout(() => {
      loadTab(activeTab, 0, q)
    }, 350)
    return () => clearTimeout(searchTimerRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const handleTabChange = (tabId: string) => {
    setActiveTab(tabId)
    if (connected) loadTab(tabId, 0, search.trim())
  }

  const isSearching = searchResults !== null
  const currentSamples = isSearching ? searchResults : (samplesByTab[activeTab] ?? [])
  const currentTotal = isSearching ? searchResults.length : (totalsByTab[activeTab] ?? 0)
  const currentPage = pageByTab[activeTab] ?? 0
  const totalPages = Math.ceil((totalsByTab[activeTab] ?? 0) / PAGE_SIZE)
  const currentTab = TABS.find(t => t.id === activeTab)!

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">SENAITE</h1>
            <p className="text-muted-foreground">Sample tracking and workflow status</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={refresh}
            className="h-8 w-8"
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
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
                    : loading && search.trim()
                      ? `Searching for "${search.trim()}"…`
                      : isSearching
                        ? currentTotal > 0
                          ? `${currentTotal} result${currentTotal !== 1 ? 's' : ''} for "${search.trim()}"`
                          : `No results for "${search.trim()}"`
                        : !loading && currentTotal > 0
                          ? `${currentTotal} sample${currentTotal !== 1 ? 's' : ''} — ${currentTab.description}`
                          : currentTab.description}
                </CardDescription>
              </div>
              {connected && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1"
                  onClick={() => window.open(`${window.location.origin}`, '_blank')}
                >
                  Open SENAITE
                  <ChevronRight className="h-3 w-3" />
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex items-center gap-3 mb-4">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search by sample ID, client, or verification code…"
                  className="pl-8 pr-8 h-8 text-sm"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
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
                      <Badge variant="secondary" className="ml-1.5 h-4 px-1.5 text-[10px]">
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
                  />
                </TabsContent>
              ))}
            </Tabs>
            {connected && !loading && totalPages > 1 && !isSearching && (
              <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/30">
                <span className="text-xs text-muted-foreground">
                  {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, currentTotal)} of {currentTotal}
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
