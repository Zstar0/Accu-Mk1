import { useState, useEffect, useCallback } from 'react'
import {
  RefreshCw,
  XCircle,
  Loader2,
  FlaskConical,
  ChevronRight,
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

const STATE_LABELS: Record<string, { label: string; className: string }> = {
  sample_registered:      { label: 'Registered',       className: 'bg-zinc-700 text-zinc-200' },
  sample_due:             { label: 'Due',               className: 'bg-yellow-900 text-yellow-300' },
  sample_received:        { label: 'Received',          className: 'bg-blue-900 text-blue-300' },
  waiting_for_addon_results: { label: 'Waiting Addon',  className: 'bg-indigo-900 text-indigo-300' },
  ready_for_review:       { label: 'Ready for Review',  className: 'bg-cyan-900 text-cyan-300' },
  to_be_verified:         { label: 'To Verify',         className: 'bg-orange-900 text-orange-300' },
  verified:               { label: 'Verified',          className: 'bg-green-900 text-green-300' },
  published:              { label: 'Published',         className: 'bg-purple-900 text-purple-300' },
  cancelled:              { label: 'Cancelled',         className: 'bg-red-900 text-red-300' },
  invalid:                { label: 'Invalid',           className: 'bg-red-900 text-red-300' },
}

function StateBadge({ state }: { state: string }) {
  const config = STATE_LABELS[state] ?? { label: state, className: 'bg-zinc-700 text-zinc-200' }
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${config.className}`}>
      {config.label}
    </span>
  )
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' })
}

// --- Sample Table ---

function SampleTable({
  samples,
  loading,
  connected,
  error,
}: {
  samples: SenaiteSample[]
  loading: boolean
  connected: boolean
  error: string | null
}) {
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

  return (
    <div className="overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-32">Sample ID</TableHead>
            <TableHead className="w-36">Order #</TableHead>
            <TableHead>Client</TableHead>
            <TableHead>Sample Type</TableHead>
            <TableHead className="w-36">Received</TableHead>
            <TableHead className="w-28 text-center">State</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {samples.map(s => (
            <TableRow key={s.uid} className="hover:bg-muted/30">
              <TableCell className="font-mono text-sm">{s.id}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{s.client_order_number ?? '—'}</TableCell>
              <TableCell className="text-sm">{s.client_id ?? '—'}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{s.sample_type ?? '—'}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{formatDate(s.date_received)}</TableCell>
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

export function SenaiteDashboard() {
  const [activeTab, setActiveTab] = useState('open')
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [samplesByTab, setSamplesByTab] = useState<Record<string, SenaiteSample[]>>({})
  const [totalsByTab, setTotalsByTab] = useState<Record<string, number>>({})

  const loadTab = useCallback(async (tabId: string, force = false) => {
    if (!force && samplesByTab[tabId] !== undefined) return
    const tab = TABS.find(t => t.id === tabId)
    if (!tab) return

    setLoading(true)
    setError(null)
    try {
      const result = await getSenaiteSamples(tab.reviewState, 50, 0)
      setSamplesByTab(prev => ({ ...prev, [tabId]: result.items }))
      setTotalsByTab(prev => ({ ...prev, [tabId]: result.total }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load samples')
    } finally {
      setLoading(false)
    }
  }, [samplesByTab])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    setSamplesByTab({})
    setTotalsByTab({})
    try {
      const status = await getSenaiteStatus()
      setConnected(status.enabled)
      if (status.enabled) {
        await loadTab(activeTab, true)
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
          const result = await getSenaiteSamples(tab.reviewState, 50, 0)
          if (cancelled) return
          setSamplesByTab({ [activeTab]: result.items })
          setTotalsByTab({ [activeTab]: result.total })
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

  const handleTabChange = (tabId: string) => {
    setActiveTab(tabId)
    if (connected) loadTab(tabId)
  }

  const currentSamples = samplesByTab[activeTab] ?? []
  const currentTotal = totalsByTab[activeTab] ?? 0
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
                  {connected && !loading
                    ? currentTotal > 0
                      ? `${currentTotal} sample${currentTotal !== 1 ? 's' : ''} — ${currentTab.description}`
                      : currentTab.description
                    : 'Connect to SENAITE to view samples'}
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
                  />
                </TabsContent>
              ))}
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  )
}
