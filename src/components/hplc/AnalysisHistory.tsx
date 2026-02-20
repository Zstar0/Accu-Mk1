import { useState, useEffect, useCallback } from 'react'
import {
  Search,
  CheckCircle2,
  XCircle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Trash2,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  getHPLCAnalyses,
  getHPLCAnalysis,
  deleteHPLCAnalysis,
  type HPLCAnalysisListItem,
  type HPLCAnalysisResult,
} from '@/lib/api'
import { AnalysisResults } from './AnalysisResults'
import { WizardSessionHistory } from './wizard/WizardSessionHistory'

const PAGE_SIZE = 20

export function AnalysisHistory() {
  const [items, setItems] = useState<HPLCAnalysisListItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Detail view
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<HPLCAnalysisResult | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const fetchList = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await getHPLCAnalyses(
        search || undefined,
        undefined,
        PAGE_SIZE,
        page * PAGE_SIZE
      )
      setItems(resp.items)
      setTotal(resp.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analyses')
    } finally {
      setLoading(false)
    }
  }, [search, page])

  useEffect(() => {
    fetchList()
  }, [fetchList])

  // Load detail when selected
  useEffect(() => {
    if (selectedId == null) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    getHPLCAnalysis(selectedId)
      .then(d => {
        if (!cancelled) setDetail(d)
      })
      .catch(() => {
        if (!cancelled) setDetail(null)
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  const handleDelete = async (id: number, label: string) => {
    if (!window.confirm(`Delete analysis for "${label}"? This cannot be undone.`)) return
    try {
      await deleteHPLCAnalysis(id)
      fetchList()
    } catch {
      setError('Failed to delete analysis')
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="flex flex-col gap-4 p-6">
      <Tabs defaultValue="hplc-import">
        <TabsList>
          <TabsTrigger value="hplc-import">HPLC Import</TabsTrigger>
          <TabsTrigger value="wizard-sessions">Sample Prep Wizard</TabsTrigger>
        </TabsList>

        <TabsContent value="hplc-import">
          {selectedId != null ? (
            /* Detail view */
            <div className="flex flex-col gap-4 mt-4">
              <Button
                variant="ghost"
                size="sm"
                className="w-fit gap-1"
                onClick={() => setSelectedId(null)}
              >
                <ChevronLeft className="h-4 w-4" />
                Back to History
              </Button>

              {detailLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : detail ? (
                <AnalysisResults result={detail} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Analysis not found.
                </p>
              )}
            </div>
          ) : (
            /* List view */
            <div className="flex flex-col gap-4 mt-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Analysis History</h2>
                <span className="text-sm text-muted-foreground">
                  {total} total
                </span>
              </div>

              {/* Search bar */}
              <div className="relative max-w-sm">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by sample ID..."
                  value={search}
                  onChange={e => {
                    setSearch(e.target.value)
                    setPage(0)
                  }}
                  className="pl-9"
                />
              </div>

              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}

              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : items.length === 0 ? (
                <Card>
                  <CardContent className="py-12 text-center text-muted-foreground">
                    {search
                      ? `No analyses matching "${search}"`
                      : 'No analyses yet. Run your first analysis from "Import Analysis".'}
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardHeader className="pb-0">
                    <CardTitle className="text-sm">Results</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <div className="overflow-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-left text-muted-foreground">
                            <th className="pb-2 pr-4 font-medium">Sample ID</th>
                            <th className="pb-2 pr-4 font-medium">Peptide</th>
                            <th className="pb-2 pr-4 font-medium text-right">Purity %</th>
                            <th className="pb-2 pr-4 font-medium text-right">Quantity (mg)</th>
                            <th className="pb-2 pr-4 font-medium">Identity</th>
                            <th className="pb-2 font-medium">Date</th>
                            <th className="pb-2 font-medium w-10"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map(item => (
                            <tr
                              key={item.id}
                              className="border-b last:border-0 cursor-pointer hover:bg-muted/50 transition-colors"
                              onClick={() => setSelectedId(item.id)}
                            >
                              <td className="py-2.5 pr-4 font-medium">
                                {item.sample_id_label}
                              </td>
                              <td className="py-2.5 pr-4">
                                <Badge variant="outline">{item.peptide_abbreviation}</Badge>
                              </td>
                              <td className="py-2.5 pr-4 text-right tabular-nums">
                                {item.purity_percent != null
                                  ? item.purity_percent.toFixed(2)
                                  : '—'}
                              </td>
                              <td className="py-2.5 pr-4 text-right tabular-nums">
                                {item.quantity_mg != null
                                  ? item.quantity_mg.toFixed(2)
                                  : '—'}
                              </td>
                              <td className="py-2.5 pr-4">
                                {item.identity_conforms === true ? (
                                  <span className="inline-flex items-center gap-1 text-green-600">
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                    Conforms
                                  </span>
                                ) : item.identity_conforms === false ? (
                                  <span className="inline-flex items-center gap-1 text-destructive">
                                    <XCircle className="h-3.5 w-3.5" />
                                    Fails
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </td>
                              <td className="py-2.5 text-muted-foreground">
                                {new Date(item.created_at).toLocaleDateString()}
                              </td>
                              <td className="py-2.5">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                  onClick={e => {
                                    e.stopPropagation()
                                    handleDelete(item.id, item.sample_id_label)
                                  }}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Pagination */}
                    {totalPages > 1 && (
                      <div className="mt-4 flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">
                          Page {page + 1} of {totalPages}
                        </span>
                        <div className="flex gap-1">
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-7 w-7"
                            disabled={page === 0}
                            onClick={() => setPage(p => p - 1)}
                          >
                            <ChevronLeft className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-7 w-7"
                            disabled={page >= totalPages - 1}
                            onClick={() => setPage(p => p + 1)}
                          >
                            <ChevronRight className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="wizard-sessions">
          <div className="mt-4">
            <WizardSessionHistory />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
