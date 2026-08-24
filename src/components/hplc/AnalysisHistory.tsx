import { useState, useEffect } from 'react'
import {
  Loader2,
  CheckCircle2,
} from 'lucide-react'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  listSamplePreps,
  getChromatogramStatus,
  type SamplePrep,
  type HplcScanMatch,
} from '@/lib/api'
import { SamplePrepHplcFlyout } from './SamplePrepHplcFlyout'

export function AnalysisHistory() {
  return (
    <div className="flex flex-col gap-4 p-6">
      <Tabs defaultValue="production">
        <TabsList>
          <TabsTrigger value="production">Production</TabsTrigger>
          <TabsTrigger value="standards">Standards</TabsTrigger>
        </TabsList>
        <TabsContent value="production">
          <div className="mt-4">
            <CompletedSamplePreps filter="production" />
          </div>
        </TabsContent>
        <TabsContent value="standards">
          <div className="mt-4">
            <CompletedSamplePreps filter="standard" />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ── Completed Sample Preps ──────────────────────────────────────────────────

const DONE_STATUSES = ['hplc_complete', 'completed', 'curve_created']
const PAGE_SIZE = 100

function CompletedSamplePreps({ filter }: { filter: 'production' | 'standard' }) {
  const [preps, setPreps] = useState<SamplePrep[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flyoutPrep, setFlyoutPrep] = useState<SamplePrep | null>(null)
  const [flyoutMatch, setFlyoutMatch] = useState<HplcScanMatch | null>(null)
  const [chromPrepIds, setChromPrepIds] = useState<Set<number>>(new Set())

  useEffect(() => {
    let cancelled = false
    Promise.all([
      // Done-statuses filter runs SERVER-side so the LIMIT window pages
      // through completed preps — client-side filtering after LIMIT capped
      // history at the done rows among the newest 100 preps of any status.
      listSamplePreps({
        limit: PAGE_SIZE,
        offset: 0,
        is_standard: filter === 'standard',
        statuses: DONE_STATUSES,
      }),
      getChromatogramStatus(),
    ])
      .then(([data, chromStatus]) => {
        if (!cancelled) {
          setPreps(data)
          setHasMore(data.length === PAGE_SIZE)
          setChromPrepIds(new Set(chromStatus.prep_ids_with_chromatogram))
        }
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [filter])

  function loadMore() {
    setLoadingMore(true)
    listSamplePreps({
      limit: PAGE_SIZE,
      offset: preps.length,
      is_standard: filter === 'standard',
      statuses: DONE_STATUSES,
    })
      .then(data => {
        setPreps(prev => [...prev, ...data])
        setHasMore(data.length === PAGE_SIZE)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to load')
      })
      .finally(() => setLoadingMore(false))
  }

  function openPrep(prep: SamplePrep) {
    const match: HplcScanMatch = {
      prep_id: prep.id,
      senaite_sample_id: prep.senaite_sample_id ?? prep.sample_id,
      folder_name: prep.senaite_sample_id ?? prep.sample_id,
      folder_id: '',
      peak_files: [],
      chrom_files: [],
    }
    setFlyoutPrep(prep)
    setFlyoutMatch(match)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return <p className="text-sm text-destructive py-4">{error}</p>
  }

  if (preps.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          No completed sample preps yet.
        </CardContent>
      </Card>
    )
  }

  return (
    <>
    <Card>
      <CardContent className="pt-4">
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Sample ID</th>
                <th className="pb-2 pr-4 font-medium">Peptide</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 pr-4 font-medium">Instrument</th>
                <th className="pb-2 pr-4 font-medium">Created By</th>
                <th className="pb-2 pr-4 font-medium">Completed</th>
                <th className="pb-2 font-medium text-center" title="Chromatogram data available">Chrom</th>
              </tr>
            </thead>
            <tbody>
              {preps.map(prep => (
                <tr
                  key={prep.id}
                  className="border-b last:border-0 hover:bg-muted/50 transition-colors cursor-pointer"
                  onClick={() => openPrep(prep)}
                >
                  <td className="py-2.5 pr-4 font-mono font-medium">
                    {prep.senaite_sample_id ?? prep.sample_id}
                  </td>
                  <td className="py-2.5 pr-4">
                    {prep.peptide_abbreviation ?? prep.peptide_name ?? '—'}
                    {prep.is_standard && (
                      <span className="ml-1.5 text-[10px] text-amber-500 font-semibold">STD</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4">
                    <Badge variant="outline" className="text-xs">
                      {prep.status === 'hplc_complete' ? 'HPLC Complete'
                        : prep.status === 'curve_created' ? 'Curve Created'
                        : 'Completed'}
                    </Badge>
                  </td>
                  <td className="py-2.5 pr-4 text-muted-foreground">
                    {prep.instrument_name ?? '—'}
                  </td>
                  <td className="py-2.5 pr-4 text-muted-foreground text-xs">
                    {prep.created_by_email ?? '—'}
                  </td>
                  <td className="py-2.5 pr-4 text-muted-foreground">
                    {new Date(prep.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </td>
                  <td className="py-2.5 text-center">
                    {chromPrepIds.has(prep.id) ? (
                      <CheckCircle2 size={14} className="inline text-emerald-500" />
                    ) : (
                      <span className="text-xs text-muted-foreground/40">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {hasMore && (
          <div className="flex justify-center pt-3">
            <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
              {loadingMore && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Load more
            </Button>
          </div>
        )}
      </CardContent>
    </Card>

    {flyoutPrep && flyoutMatch && (
      <SamplePrepHplcFlyout
        open={true}
        onClose={() => { setFlyoutPrep(null); setFlyoutMatch(null) }}
        prep={flyoutPrep}
        match={flyoutMatch}
        readOnly
      />
    )}
    </>
  )
}

