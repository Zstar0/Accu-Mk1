import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Inbox, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InboxSampleTable } from '@/components/hplc/InboxSampleTable'
import {
  useInboxSamples,
  usePriorityMutation,
  useBulkUpdateMutation,
} from '@/hooks/use-inbox-samples'
import {
  getWorksheetUsers,
  getInstruments,
  type InboxPriority,
} from '@/lib/api'

// ─── Skeleton ────────────────────────────────────────────────────────────────

function TableSkeleton() {
  return (
    <div className="rounded-md border overflow-hidden">
      {/* Header */}
      <div className="flex gap-4 bg-muted/40 px-4 py-3 border-b">
        {[8, 16, 24, 16, 20, 20, 12, 14].map((w, i) => (
          <div
            key={i}
            className={`h-4 rounded bg-muted animate-pulse w-${w}`}
          />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: 6 }).map((_, row) => (
        <div
          key={row}
          className="flex gap-4 px-4 py-3 border-b last:border-0 items-center"
        >
          {[8, 16, 24, 16, 20, 20, 12, 14].map((w, i) => (
            <div
              key={i}
              className={`h-4 rounded bg-muted animate-pulse w-${w}`}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WorksheetsInboxPage() {
  const {
    data: inboxData,
    isLoading,
    isError,
    error,
    refetch,
  } = useInboxSamples()

  const priorityMutation = usePriorityMutation()
  const bulkUpdateMutation = useBulkUpdateMutation()

  const { data: users = [] } = useQuery({
    queryKey: ['worksheet-users'],
    queryFn: getWorksheetUsers,
    staleTime: 5 * 60 * 1000,
  })

  const { data: instrumentsRaw = [] } = useQuery({
    queryKey: ['instruments'],
    queryFn: getInstruments,
    staleTime: 5 * 60 * 1000,
  })

  const instruments = instrumentsRaw.map(inst => ({
    uid: inst.senaite_uid ?? String(inst.id),
    title: inst.name,
  }))

  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set())

  const samples = inboxData?.items ?? []
  const total = inboxData?.total ?? 0

  function handlePriorityChange(sampleUid: string, priority: InboxPriority) {
    priorityMutation.mutate({ sampleUid, priority })
  }

  function handleTechAssign(sampleUids: string[], analystId: number) {
    bulkUpdateMutation.mutate({
      sample_uids: sampleUids,
      analyst_id: analystId,
    })
  }

  function handleInstrumentAssign(sampleUids: string[], instrumentUid: string) {
    bulkUpdateMutation.mutate({
      sample_uids: sampleUids,
      instrument_uid: instrumentUid,
    })
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Received Samples</h1>
            {!isLoading && !isError && (
              <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-sm font-medium text-muted-foreground">
                {total}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Auto-refreshes every 30s
          </p>
        </div>
      </div>

      {/* Loading state */}
      {isLoading && <TableSkeleton />}

      {/* Error state */}
      {isError && (
        <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-destructive/30 bg-destructive/5 py-12">
          <p className="text-sm text-destructive font-medium">
            {error instanceof Error ? error.message : 'Failed to load received samples'}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            className="gap-2"
          >
            <RefreshCw className="size-4" />
            Retry
          </Button>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && samples.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border py-16 text-center">
          <Inbox className="size-12 text-muted-foreground/50" />
          <p className="text-sm font-medium text-muted-foreground">No received samples</p>
          <p className="text-xs text-muted-foreground/60">
            Samples with status "Received" will appear here
          </p>
        </div>
      )}

      {/* Main table */}
      {!isLoading && !isError && samples.length > 0 && (
        <>
          {/* Bulk toolbar slot — Plan 04 will render the floating toolbar here */}

          <InboxSampleTable
            samples={samples}
            selectedUids={selectedUids}
            onSelectionChange={setSelectedUids}
            users={users}
            instruments={instruments}
            onPriorityChange={handlePriorityChange}
            onTechAssign={handleTechAssign}
            onInstrumentAssign={handleInstrumentAssign}
          />
        </>
      )}
    </div>
  )
}
