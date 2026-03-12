import { useState, useEffect, useCallback } from 'react'
import { Loader2, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CalibrationPanel } from './CalibrationPanel'
import {
  getBlendCalibrations,
  type PeptideRecord,
  type BlendCalibrationData,
  type AnalyteResponse,
} from '@/lib/api'

interface BlendCalibrationPanelProps {
  peptide: PeptideRecord
  instrumentFilter: string
  onNavigateToComponent?: (peptideId: number) => void
}

export function BlendCalibrationPanel({
  peptide,
  instrumentFilter,
  onNavigateToComponent,
}: BlendCalibrationPanelProps) {
  const [data, setData] = useState<BlendCalibrationData | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    try {
      setLoading(true)
      const result = await getBlendCalibrations(peptide.id)
      setData(result)
      // Auto-select first component
      const keys = Object.keys(result)
      if (keys.length > 0 && !selectedComponent) {
        setSelectedComponent(keys[0] ?? null)
      }
    } catch (err) {
      console.error('Failed to load blend calibrations:', err)
    } finally {
      setLoading(false)
    }
  }, [peptide.id])

  useEffect(() => {
    loadData()
    setSelectedComponent(null)
  }, [loadData])

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading component curves...
      </div>
    )
  }

  if (!data || Object.keys(data).length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
        <p className="text-sm">No component peptides linked to this blend.</p>
      </div>
    )
  }

  const componentKeys = Object.keys(data)
  const current = selectedComponent ? data[selectedComponent] : null

  // Build a minimal PeptideRecord-like object for CalibrationPanel
  const componentAsPeptide: PeptideRecord | null = current
    ? {
        id: current.peptide_id,
        name: current.name,
        abbreviation: selectedComponent!,
        active: true,
        is_blend: false,
        created_at: '',
        updated_at: '',
        methods: [],
        active_calibration: null,
        calibration_summary: [],
        analytes: [] as AnalyteResponse[],
        components: [],
        prep_vial_count: 1,
      }
    : null

  return (
    <div className="flex flex-col gap-4">
      {/* Component sub-tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {componentKeys.map(abbr => {
          const comp = data[abbr]
          const curveCount = comp?.calibrations.filter(
            c => instrumentFilter === 'all' || (c.instrument ?? 'unknown') === instrumentFilter
          ).length
          return (
            <Button
              key={abbr}
              size="sm"
              variant={selectedComponent === abbr ? 'default' : 'outline'}
              onClick={() => setSelectedComponent(abbr)}
              className="h-7 text-xs gap-1.5"
            >
              {abbr}
              <Badge
                variant={selectedComponent === abbr ? 'secondary' : 'outline'}
                className="text-[10px] px-1 py-0 h-4 min-w-4 justify-center"
              >
                {curveCount}
              </Badge>
            </Button>
          )
        })}
      </div>

      {/* Component curves via CalibrationPanel */}
      {componentAsPeptide && current && (
        <div className="flex flex-col gap-3">
          {onNavigateToComponent && (
            <Button
              variant="link"
              size="sm"
              className="self-start h-auto p-0 text-xs text-muted-foreground hover:text-primary gap-1"
              onClick={() => onNavigateToComponent(current.peptide_id)}
            >
              Manage {selectedComponent} curves
              <ExternalLink className="h-3 w-3" />
            </Button>
          )}
          <CalibrationPanel
            peptide={componentAsPeptide}
            instrumentFilter={instrumentFilter}
            onUpdated={loadData}
          />
        </div>
      )}
    </div>
  )
}
