import { useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePeptideRequestsList } from '@/hooks/peptide-requests'
import {
  ACTIVE_STATUSES,
  CLOSED_STATUSES,
  type PeptideRequest,
} from '@/types/peptide-request'
import { PeptideRequestRow } from '@/components/peptide-request-row'
import { useUIStore } from '@/store/ui-store'

export function PeptideRequestsList() {
  const [tab, setTab] = useState<'active' | 'closed'>('active')
  // Retirement is orthogonal to status. A retired row keeps its last
  // workflow status but should disappear from Active and appear in
  // Closed regardless of status. The Active tab filters by status
  // server-side and we additionally hide retired rows client-side. The
  // Closed tab omits the status filter so the server returns retired
  // rows too (retired rows can have an active-status value), then we
  // filter to rows that are either retired or in a closed status.
  const query = usePeptideRequestsList({
    status: tab === 'active' ? ACTIVE_STATUSES : undefined,
  })

  const items: PeptideRequest[] = query.data?.items ?? []
  const visible =
    tab === 'active'
      ? items.filter(r => r.retired_at === null)
      : items.filter(
          r => r.retired_at !== null || CLOSED_STATUSES.includes(r.status),
        )

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Peptide Requests</h1>
      <Tabs value={tab} onValueChange={v => setTab(v as 'active' | 'closed')}>
        <TabsList>
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="closed">Closed</TabsTrigger>
        </TabsList>
        <TabsContent value={tab}>
          {query.isLoading && <p>Loading…</p>}
          {query.isError && <p>Error loading requests.</p>}
          {query.data && (
            <div className="divide-y">
              {visible.length === 0 ? (
                <p className="py-4 text-muted-foreground">No requests.</p>
              ) : (
                visible.map(r => (
                  <button
                    key={r.id}
                    type="button"
                    className="block w-full text-left"
                    onClick={() =>
                      useUIStore.getState().navigateToPeptideRequest(r.id)
                    }
                  >
                    <PeptideRequestRow request={r} />
                  </button>
                ))
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
