import { useState, useEffect, useCallback } from 'react'
import {
  RefreshCw,
  XCircle,
  Loader2,
  ScrollText,
  Check,
  X,
  Filter,
  Search,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getAllSampleEvents, type ExplorerSampleEvent } from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { StateBadge, formatDate } from '@/components/senaite/senaite-utils'

// --- Transition labels ---

const TRANSITION_LABELS: Record<string, { label: string; className: string }> = {
  receive:  { label: 'Receive',  className: 'text-blue-400' },
  submit:   { label: 'Submit',   className: 'text-orange-400' },
  verify:   { label: 'Verify',   className: 'text-green-400' },
  publish:  { label: 'Publish',  className: 'text-purple-400' },
  retract:  { label: 'Retract',  className: 'text-red-400' },
  cancel:   { label: 'Cancel',   className: 'text-red-400' },
  reinstate: { label: 'Reinstate', className: 'text-yellow-400' },
}

function TransitionBadge({ transition }: { transition: string }) {
  const config = TRANSITION_LABELS[transition] ?? { label: transition, className: 'text-muted-foreground' }
  return (
    <span className={`text-xs font-medium capitalize ${config.className}`}>
      {config.label}
    </span>
  )
}

// --- Main Component ---

export function SampleEventLog() {
  const navigateToSample = useUIStore(state => state.navigateToSample)
  const [events, setEvents] = useState<ExplorerSampleEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sampleFilter, setSampleFilter] = useState('')

  const loadEvents = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getAllSampleEvents(200)
      setEvents(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load events')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadEvents()
  }, [loadEvents])

  const filteredEvents = sampleFilter
    ? events.filter(e => e.sample_id.toLowerCase().includes(sampleFilter.toLowerCase()))
    : events

  const filterBySample = (sampleId: string) => {
    setSampleFilter(prev => prev === sampleId ? '' : sampleId)
  }

  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
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

    if (events.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
          <ScrollText className="h-6 w-6" />
          <p className="text-sm">No events recorded</p>
        </div>
      )
    }

    if (filteredEvents.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
          <Search className="h-6 w-6" />
          <p className="text-sm">No events match "{sampleFilter}"</p>
          <Button variant="ghost" size="sm" onClick={() => setSampleFilter('')}>
            Clear filter
          </Button>
        </div>
      )
    }

    return (
      <div className="overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Sample ID</TableHead>
              <TableHead className="w-24">Transition</TableHead>
              <TableHead className="w-32 text-center">New Status</TableHead>
              <TableHead className="w-24 text-center">WP Notified</TableHead>
              <TableHead className="w-28">WP Status</TableHead>
              <TableHead className="w-40">Timestamp</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredEvents.map(event => (
              <TableRow key={event.id} className="hover:bg-muted/30">
                <TableCell>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="font-mono text-sm text-blue-400 hover:text-blue-300 hover:underline cursor-pointer"
                      onClick={() => navigateToSample(event.sample_id)}
                    >
                      {event.sample_id}
                    </button>
                    <button
                      type="button"
                      className={`p-0.5 rounded transition-colors cursor-pointer ${
                        sampleFilter === event.sample_id
                          ? 'text-blue-400 bg-blue-500/20'
                          : 'text-muted-foreground/30 hover:text-muted-foreground/70'
                      }`}
                      onClick={() => filterBySample(event.sample_id)}
                      title={sampleFilter === event.sample_id ? `Clear filter` : `Filter by ${event.sample_id}`}
                    >
                      <Filter className="h-3 w-3" />
                    </button>
                  </div>
                </TableCell>
                <TableCell>
                  <TransitionBadge transition={event.transition} />
                </TableCell>
                <TableCell className="text-center">
                  <StateBadge state={event.new_status} />
                </TableCell>
                <TableCell className="text-center">
                  {event.wp_notified ? (
                    <Check className="h-4 w-4 text-green-500 mx-auto" />
                  ) : (
                    <X className="h-4 w-4 text-muted-foreground/40 mx-auto" />
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {event.wp_status_sent ?? '—'}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDate(event.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Event Log</h1>
            <p className="text-muted-foreground">Sample workflow status transitions</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={loadEvents}
            className="h-8 w-8"
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {/* Events Card */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <CardTitle className="text-base flex items-center gap-2">
                  <ScrollText className="h-4 w-4 text-blue-500" />
                  Status Events
                </CardTitle>
                <CardDescription>
                  {!loading && !error
                    ? events.length > 0
                      ? sampleFilter
                        ? `${filteredEvents.length} of ${events.length} events for "${sampleFilter}"`
                        : `${events.length} event${events.length !== 1 ? 's' : ''} — most recent first`
                      : 'No workflow events recorded yet'
                    : 'Loading events...'}
                </CardDescription>
              </div>
              <div className="relative shrink-0">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
                <Input
                  placeholder="Filter by Sample ID..."
                  value={sampleFilter}
                  onChange={e => setSampleFilter(e.target.value)}
                  className="h-8 w-48 pl-8 text-sm"
                />
                {sampleFilter && (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground cursor-pointer"
                    onClick={() => setSampleFilter('')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {renderContent()}
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  )
}
