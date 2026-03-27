import { useState, useEffect } from 'react'
import {
  Loader2,
} from 'lucide-react'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  listSamplePreps,
  getHPLCAnalysesBySamplePrep,
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

function CompletedSamplePreps({ filter }: { filter: 'production' | 'standard' }) {
  const [preps, setPreps] = useState<SamplePrep[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [flyoutPrep, setFlyoutPrep] = useState<SamplePrep | null>(null)
  const [flyoutMatch, setFlyoutMatch] = useState<HplcScanMatch | null>(null)

  useEffect(() => {
    let cancelled = false
    listSamplePreps({
      limit: 100,
      is_standard: filter === 'standard' ? true : false,
    })
      .then(data => {
        if (!cancelled) {
          setPreps(data.filter(p => DONE_STATUSES.includes(p.status)))
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

  async function openPrep(prep: SamplePrep) {
    // Build a stub match from stored analysis data so the flyout can open
    let folderName = prep.senaite_sample_id ?? prep.sample_id
    try {
      const results = await getHPLCAnalysesBySamplePrep(prep.id)
      if (results.length > 0 && results[0]!.source_sharepoint_folder) {
        folderName = results[0]!.source_sharepoint_folder
      }
    } catch { /* use fallback folder name */ }

    const match: HplcScanMatch = {
      prep_id: prep.id,
      senaite_sample_id: prep.senaite_sample_id ?? prep.sample_id,
      folder_name: folderName,
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
                <th className="pb-2 font-medium">Completed</th>
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
                  <td className="py-2.5 text-muted-foreground">
                    {new Date(prep.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>

    {flyoutPrep && flyoutMatch && (
      <SamplePrepHplcFlyout
        open={true}
        onClose={() => { setFlyoutPrep(null); setFlyoutMatch(null) }}
        prep={flyoutPrep}
        match={flyoutMatch}
      />
    )}
    </>
  )
}

