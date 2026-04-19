import { useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePeptideRequestsList } from '@/hooks/peptide-requests'
import { ACTIVE_STATUSES, CLOSED_STATUSES } from '@/types/peptide-request'
import { PeptideRequestRow } from '@/components/peptide-request-row'
import { useUIStore } from '@/store/ui-store'

export function PeptideRequestsList() {
  const [tab, setTab] = useState<'active' | 'closed'>('active')
  const query = usePeptideRequestsList({
    status: tab === 'active' ? ACTIVE_STATUSES : CLOSED_STATUSES,
  })

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
              {query.data.items.length === 0 ? (
                <p className="py-4 text-muted-foreground">No requests.</p>
              ) : (
                query.data.items.map(r => (
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
