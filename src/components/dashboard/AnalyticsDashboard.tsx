import { useState, useEffect, useCallback } from 'react'
import {
  FlaskConical,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Loader2,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getPeptides, type PeptideRecord } from '@/lib/api'
import { useUIStore } from '@/store/ui-store'

export function AnalyticsDashboard() {
  const navigateTo = useUIStore(state => state.navigateTo)

  const [peptides, setPeptides] = useState<PeptideRecord[]>([])
  const [loading, setLoading] = useState(true)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getPeptides()
      setPeptides(data)
    } catch {
      // Peptides may not be available
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const noCurvePeptides = peptides.filter(p => !p.active_calibration)
  const withCurvePeptides = peptides.filter(p => !!p.active_calibration)

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 p-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Analytics Dashboard</h1>
          <p className="text-muted-foreground">
            Peptide standards and calibration status
          </p>
        </div>

        {/* KPI Row */}
        <div className="flex items-center gap-6 text-sm">
          <div className="flex items-center gap-1.5">
            <FlaskConical className="h-3.5 w-3.5 text-blue-400" />
            <span className="font-semibold">{peptides.length}</span>
            <span className="text-muted-foreground">peptides</span>
          </div>
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />
            <span className="font-semibold">{withCurvePeptides.length}</span>
            <span className="text-muted-foreground">with curves</span>
          </div>
          <div className="flex items-center gap-1.5">
            <AlertTriangle className={`h-3.5 w-3.5 ${noCurvePeptides.length > 0 ? 'text-yellow-400' : 'text-green-400'}`} />
            <span className="font-semibold">{noCurvePeptides.length}</span>
            <span className="text-muted-foreground">missing</span>
          </div>
        </div>

        {/* Peptides Missing Curves */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-yellow-500" />
                  Peptides Without Curves
                </CardTitle>
                <CardDescription>
                  {noCurvePeptides.length === 0
                    ? 'All peptides have calibration curves'
                    : `${noCurvePeptides.length} peptide${noCurvePeptides.length !== 1 ? 's' : ''} need calibration data`}
                </CardDescription>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs gap-1"
                onClick={() => navigateTo('hplc-analysis', 'peptide-config')}
              >
                Peptide Config
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : noCurvePeptides.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-6 text-green-500">
                <CheckCircle2 className="h-6 w-6" />
                <p className="text-sm text-muted-foreground">All set!</p>
              </div>
            ) : (
              <div className="max-h-72 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Peptide</TableHead>
                      <TableHead className="text-right">Ref RT</TableHead>
                      <TableHead className="text-center">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {noCurvePeptides.map(p => (
                      <TableRow
                        key={p.id}
                        className="cursor-pointer hover:bg-muted/30"
                        onClick={() => navigateTo('hplc-analysis', 'peptide-config')}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{p.abbreviation}</span>
                            <span className="text-xs text-muted-foreground">{p.name}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {p.reference_rt != null ? `${p.reference_rt.toFixed(3)} min` : '—'}
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant="outline" className="text-xs border-yellow-600/50 text-yellow-500">
                            No Curve
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  )
}
