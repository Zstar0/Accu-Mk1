import { useState, useEffect, useCallback } from 'react'
import {
  Plus,
  Trash2,
  ChevronRight,
  FlaskConical,
  Loader2,
  AlertCircle,
  Download,
  X,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PeptideForm } from './PeptideForm'
import { CalibrationPanel } from './CalibrationPanel'
import {
  getPeptides,
  deletePeptide,
  seedPeptides,
  type PeptideRecord,
  type SeedPeptidesResult,
} from '@/lib/api'

export function PeptideConfig() {
  const [peptides, setPeptides] = useState<PeptideRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [seedResult, setSeedResult] = useState<SeedPeptidesResult | null>(null)

  const loadPeptides = useCallback(async () => {
    try {
      setLoading(true)
      const data = await getPeptides()
      setPeptides(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load peptides')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPeptides()
  }, [loadPeptides])

  const handleDelete = useCallback(
    async (id: number) => {
      try {
        await deletePeptide(id)
        if (selectedId === id) setSelectedId(null)
        await loadPeptides()
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to delete peptide'
        )
      }
    },
    [selectedId, loadPeptides]
  )

  const handleSeed = useCallback(async () => {
    setSeeding(true)
    setSeedResult(null)
    setError(null)
    try {
      const result = await seedPeptides()
      setSeedResult(result)
      await loadPeptides()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Seed failed')
    } finally {
      setSeeding(false)
    }
  }, [loadPeptides])

  const selectedPeptide = peptides.find(p => p.id === selectedId) ?? null

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Peptide Configuration
            </h1>
            <p className="text-muted-foreground">
              Manage peptides, reference retention times, and calibration curves.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleSeed}
              disabled={seeding}
              className="gap-2"
            >
              {seeding ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {seeding ? 'Importing...' : 'Import from Lab'}
            </Button>
            <Button onClick={() => setShowAddForm(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              Add Peptide
            </Button>
          </div>
        </div>

        {error && (
          <Card className="border-destructive">
            <CardContent className="flex items-center gap-2 pt-6">
              <AlertCircle className="h-4 w-4 text-destructive" />
              <span className="text-sm text-destructive">{error}</span>
            </CardContent>
          </Card>
        )}

        {/* Seed results */}
        {seedResult && (
          <Card className={seedResult.success ? 'border-green-500' : 'border-destructive'}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">
                  {seedResult.success ? 'Import Complete' : 'Import Failed'}
                </CardTitle>
                <button
                  type="button"
                  onClick={() => setSeedResult(null)}
                  className="rounded p-1 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </CardHeader>
            <CardContent>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs font-mono">
                {seedResult.output || seedResult.errors || 'No output'}
              </pre>
            </CardContent>
          </Card>
        )}

        {/* Add peptide form */}
        {showAddForm && (
          <PeptideForm
            onSaved={() => {
              setShowAddForm(false)
              loadPeptides()
            }}
            onCancel={() => setShowAddForm(false)}
          />
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Peptide List */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Peptides</CardTitle>
              <CardDescription>
                {peptides.length} peptide{peptides.length !== 1 ? 's' : ''}{' '}
                configured
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : peptides.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground">
                  <FlaskConical className="h-8 w-8" />
                  <p className="text-sm">No peptides configured yet</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowAddForm(true)}
                  >
                    Add your first peptide
                  </Button>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Peptide</TableHead>
                      <TableHead className="text-right">Ref RT</TableHead>
                      <TableHead className="text-center">
                        Calibration
                      </TableHead>
                      <TableHead className="w-16"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {peptides.map(p => (
                      <TableRow
                        key={p.id}
                        className={
                          selectedId === p.id
                            ? 'bg-muted/50 cursor-pointer'
                            : 'cursor-pointer hover:bg-muted/30'
                        }
                        onClick={() => setSelectedId(p.id)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">
                              {p.abbreviation}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {p.name}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {p.reference_rt != null
                            ? `${p.reference_rt.toFixed(3)} min`
                            : '—'}
                        </TableCell>
                        <TableCell className="text-center">
                          {p.active_calibration ? (
                            <Badge
                              variant="default"
                              className="text-xs"
                            >
                              Active
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs">
                              None
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation()
                                handleDelete(p.id)
                              }}
                              className="rounded p-1 text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Detail Panel */}
          {selectedPeptide ? (
            <CalibrationPanel
              peptide={selectedPeptide}
              onUpdated={loadPeptides}
            />
          ) : (
            <Card>
              <CardContent className="flex h-full items-center justify-center py-16 text-muted-foreground">
                <p className="text-sm">
                  Select a peptide to view calibration details
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}
