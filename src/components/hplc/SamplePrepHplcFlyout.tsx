/**
 * SamplePrepHplcFlyout
 *
 * Right-side flyout (Sheet) that processes HPLC data for a single sample prep.
 *
 * Single scrollable view — analysis runs automatically once data + calibration
 * are loaded. Changing the calibration curve re-runs analysis.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import {
  CheckCircle2,
  Microscope,
  AlertTriangle,
  ArrowRight,
} from 'lucide-react'
import {
  downloadSharePointFiles,
  parseHPLCFiles,
  getCalibrations,
  runHPLCAnalysis,
  getFolderChromFiles,
  type SamplePrep,
  type HplcScanMatch,
  type CalibrationCurve,
  type HPLCParseResult,
  type HPLCInjection,
  type HPLCAnalysisResult,
} from '@/lib/api'
import { PeakTable } from '@/components/hplc/PeakTable'
import {
  parseChromatogramCsv,
  downsampleLTTB,
  type ChromatogramTrace,
} from '@/components/hplc/ChromatogramChart'
import { AnalysisResults } from '@/components/hplc/AnalysisResults'
import { CalculationVisuals } from '@/components/hplc/CalculationVisuals'
import { SenaiteResultsView } from '@/components/hplc/SenaiteResultsView'

// ─── Injection tabs ───────────────────────────────────────────────────────────

function InjectionTabs({
  injections, active, onSelect,
}: {
  injections: HPLCInjection[]
  active: number
  onSelect: (i: number) => void
}) {
  return (
    <div className="flex gap-1 mb-3 flex-wrap">
      {injections.map((inj, i) => (
        <button
          key={i}
          onClick={() => onSelect(i)}
          className={cn(
            'px-3 py-1 text-xs rounded-md border font-mono transition-colors',
            i === active
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-background border-border hover:bg-muted',
          )}
        >
          {inj.injection_name} {inj.peaks.length}
        </button>
      ))}
    </div>
  )
}

// ─── Weight row ───────────────────────────────────────────────────────────────

function WeightRow({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium">
        {value != null
          ? `${value.toFixed(2)} mg`
          : <span className="text-muted-foreground">—</span>}
      </span>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  open: boolean
  onClose: () => void
  prep: SamplePrep
  match: HplcScanMatch
}

export function SamplePrepHplcFlyout({ open, onClose, prep, match }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Preview
  const [loading, setLoading] = useState(false)
  const [parseResult, setParseResult] = useState<HPLCParseResult | null>(null)
  const [chromTraces, setChromTraces] = useState<ChromatogramTrace[]>([])
  const [parseError, setParseError] = useState<string | null>(null)
  const [activeInj, setActiveInj] = useState(0)

  // Configure
  const [calibrations, setCalibrations] = useState<CalibrationCurve[]>([])
  const [calLoading, setCalLoading] = useState(false)
  const [selectedCalId, setSelectedCalId] = useState<number | null>(null)
  const [changingCurve, setChangingCurve] = useState(false)

  // Analysis
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<HPLCAnalysisResult | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  // View toggle
  const [view, setView] = useState<'analysis' | 'results'>('analysis')

  // Reset state on open
  useEffect(() => {
    if (open) {
      setParseResult(null)
      setChromTraces([])
      setParseError(null)
      setActiveInj(0)
      setChangingCurve(false)
      setResult(null)
      setRunError(null)
      setView('analysis')
    }
  }, [open, prep.id])

  // ── Download + parse peak data ──────────────────────────────────────────────

  const loadPeakData = useCallback(async () => {
    if (parseResult) return
    setLoading(true)
    setParseError(null)
    try {
      let chromItems = match.chrom_files
      if (chromItems.length === 0 && match.folder_id) {
        try {
          chromItems = await getFolderChromFiles(match.folder_id)
        } catch {
          // non-fatal — chromatogram just won't show
        }
      }

      const allFiles = [...match.peak_files, ...chromItems]
      const ids = allFiles.map(f => f.id)
      const downloaded = await downloadSharePointFiles(ids)

      const peakFileNames = new Set(match.peak_files.map(f => f.name))
      const peakFiles   = downloaded.filter(d => peakFileNames.has(d.filename))
      const chromFiles  = downloaded.filter(d => !peakFileNames.has(d.filename))

      const parsed = await parseHPLCFiles(
        peakFiles.map(d => ({ filename: d.filename, content: d.content }))
      )
      setParseResult(parsed)

      const traces: ChromatogramTrace[] = chromFiles.map(d => {
        const raw = parseChromatogramCsv(d.content)
        const pts = downsampleLTTB(raw, 800)
        return { name: d.filename.replace(/\.csv$/i, ''), points: pts }
      })
      setChromTraces(traces)
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Failed to load HPLC data')
    } finally {
      setLoading(false)
    }
  }, [match, parseResult])

  useEffect(() => {
    if (open) loadPeakData()
  }, [open, loadPeakData])

  // ── Load calibrations ───────────────────────────────────────────────────────

  const loadCalibrations = useCallback(async () => {
    if (!prep.peptide_id) return
    setCalLoading(true)
    try {
      const cals = await getCalibrations(prep.peptide_id)
      setCalibrations(cals)
      const active = cals.find(c => c.is_active)
      setSelectedCalId(active?.id ?? cals[0]?.id ?? null)
      // No need to edit if only one curve
      setChangingCurve(false)
    } catch { /* non-fatal */ }
    finally { setCalLoading(false) }
  }, [prep.peptide_id])

  useEffect(() => {
    if (open) loadCalibrations()
  }, [open, loadCalibrations])

  // ── Run analysis (auto-triggered) ──────────────────────────────────────────

  const runAnalysis = useCallback(async () => {
    if (!parseResult || !prep.peptide_id || !selectedCalId) return
    setRunning(true)
    setRunError(null)
    try {
      const res = await runHPLCAnalysis({
        sample_id_label: prep.senaite_sample_id ?? prep.sample_id,
        peptide_id: prep.peptide_id,
        calibration_curve_id: selectedCalId,
        weights: {
          stock_vial_empty:                 prep.stock_vial_empty_mg   ?? 0,
          stock_vial_with_diluent:          prep.stock_vial_loaded_mg  ?? 0,
          dil_vial_empty:                   prep.dil_vial_empty_mg     ?? 0,
          dil_vial_with_diluent:            prep.dil_vial_with_diluent_mg ?? 0,
          dil_vial_with_diluent_and_sample: prep.dil_vial_final_mg     ?? 0,
        },
        injections: parseResult.injections as unknown as Record<string, unknown>[],
      })
      setResult(res)
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Analysis failed')
    } finally {
      setRunning(false)
    }
  }, [parseResult, prep, selectedCalId])

  // Auto-run when peak data + calibration are both ready
  useEffect(() => {
    if (parseResult && selectedCalId && prep.peptide_id && !result && !running && !runError) {
      runAnalysis()
    }
  }, [parseResult, selectedCalId, prep.peptide_id, result, running, runError, runAnalysis])

  // ── Derived ─────────────────────────────────────────────────────────────────

  const injections = parseResult?.injections ?? []
  const activeInjData = injections[activeInj]
  const selectedCal = calibrations.find(c => c.id === selectedCalId)

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <Sheet open={open} onOpenChange={v => !v && onClose()}>
      <SheetContent
        ref={scrollRef}
        side="right"
        className="w-340 sm:max-w-340 overflow-y-auto p-0"
      >
        {/* Header */}
        <SheetHeader className="px-6 pt-6 pb-4 border-b border-border/60">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <Microscope size={16} className="text-emerald-500" />
            </div>
            <div className="min-w-0">
              <SheetTitle className="text-base font-semibold truncate">
                Process HPLC — {prep.senaite_sample_id ?? prep.sample_id}
              </SheetTitle>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {match.folder_name}
              </p>
            </div>
          </div>
        </SheetHeader>

        {view === 'analysis' ? (
          <>
            <div className="flex gap-6 px-6 py-5">
              {/* ════ Left column — results + data ════════════════════════ */}
              <div className="flex-1 min-w-0 space-y-5">
                {/* Analysis results */}
                {running && (
                  <div className="flex flex-col items-center gap-3 py-8">
                    <Spinner className="size-6" />
                    <p className="text-sm text-muted-foreground">Running analysis…</p>
                  </div>
                )}
                {result && (
                  <>
                    <AnalysisResults result={result} chromatograms={chromTraces} hideTrace />

                    {/* Peak table right under the chromatogram */}
                    {injections.length > 1 && (
                      <InjectionTabs
                        injections={injections}
                        active={activeInj}
                        onSelect={setActiveInj}
                      />
                    )}
                    {activeInjData && activeInjData.peaks.length > 0 && (
                      <div>
                        <p className="text-sm font-semibold mb-2">
                          Peak Data
                          {injections.length > 1 && (
                            <span className="ml-1 font-normal text-muted-foreground text-xs">
                              — {activeInjData.injection_name}
                            </span>
                          )}
                        </p>
                        <PeakTable
                          peaks={activeInjData.peaks}
                          totalArea={activeInjData.total_area}
                        />
                      </div>
                    )}
                  </>
                )}

                {/* Loading state */}
                {loading && (
                  <div className="flex flex-col items-center gap-3 py-12">
                    <Spinner className="size-6" />
                    <p className="text-sm text-muted-foreground">Downloading HPLC data from SharePoint…</p>
                  </div>
                )}

                {parseError && (
                  <div className="flex items-start gap-3 p-4 rounded-lg border border-destructive/30 bg-destructive/5">
                    <AlertTriangle size={16} className="text-destructive mt-0.5 shrink-0" />
                    <p className="text-sm text-destructive">{parseError}</p>
                  </div>
                )}

                {/* Content after data loaded */}
                {!loading && parseResult && (
                  <>
                    {/* Weights from prep */}
                    <div>
                      <p className="text-sm font-semibold mb-3">Sample Prep Weights</p>
                      <div className="rounded-md border border-border p-4">
                        <WeightRow label="Empty vial (Peptide + Septum)"  value={prep.stock_vial_empty_mg} />
                        <WeightRow label="Loaded vial (after diluent)"    value={prep.stock_vial_loaded_mg} />
                        <WeightRow label="Dil. vial — empty"              value={prep.dil_vial_empty_mg} />
                        <WeightRow label="Dil. vial + diluent"            value={prep.dil_vial_with_diluent_mg} />
                        <WeightRow label="Dil. vial (final)"              value={prep.dil_vial_final_mg} />
                      </div>
                    </div>

                    {/* Calibration Curve */}
                    <div>
                      <p className="text-sm font-semibold mb-3">Calibration Curve</p>

                      {calLoading ? (
                        <div className="flex items-center gap-2 py-4">
                          <Spinner className="size-4" />
                          <span className="text-sm text-muted-foreground">Loading calibrations…</span>
                        </div>
                      ) : calibrations.length === 0 ? (
                        <div className="flex items-center gap-2 p-4 rounded-md border border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20">
                          <AlertTriangle size={14} className="text-amber-500 shrink-0" />
                          <p className="text-sm text-amber-700 dark:text-amber-400">
                            No calibration curves for {prep.peptide_abbreviation ?? 'this peptide'}.
                          </p>
                        </div>
                      ) : changingCurve ? (
                        <div className="space-y-2">
                          {calibrations.map(cal => (
                            <button
                              key={cal.id}
                              className={cn(
                                'w-full flex items-start justify-between gap-3 p-3 rounded-md border text-left transition-colors',
                                cal.id === selectedCalId
                                  ? 'border-primary/50 bg-primary/5'
                                  : 'border-border hover:border-border/80 hover:bg-muted/40',
                              )}
                              onClick={() => { setSelectedCalId(cal.id); setChangingCurve(false); setResult(null); setRunError(null) }}
                            >
                              <div className="space-y-0.5 min-w-0">
                                <p className="text-sm font-medium truncate">
                                  {cal.source_filename ?? `Calibration #${cal.id}`}
                                </p>
                                <p className="text-xs text-muted-foreground font-mono">
                                  y = {cal.slope.toFixed(4)}x + {cal.intercept.toFixed(4)}
                                  {' · '}R² = {cal.r_squared.toFixed(4)}
                                </p>
                                {cal.source_date && (
                                  <p className="text-xs text-muted-foreground">
                                    {new Date(cal.source_date).toLocaleDateString()}
                                  </p>
                                )}
                              </div>
                              <div className="flex flex-col items-end gap-1 shrink-0">
                                {cal.is_active && (
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                                  >
                                    Active
                                  </Badge>
                                )}
                                {cal.id === selectedCalId && (
                                  <CheckCircle2 size={14} className="text-primary" />
                                )}
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : selectedCal ? (
                        <div className="p-3 rounded-md border border-primary/50 bg-primary/5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-0.5 min-w-0">
                              <p className="text-sm font-medium truncate">
                                {selectedCal.source_filename ?? `Calibration #${selectedCal.id}`}
                              </p>
                              <p className="text-xs text-muted-foreground font-mono">
                                y = {selectedCal.slope.toFixed(4)}x + {selectedCal.intercept.toFixed(4)}
                                {' · '}R² = {selectedCal.r_squared.toFixed(4)}
                              </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {selectedCal.is_active && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                                >
                                  Active
                                </Badge>
                              )}
                              {calibrations.length > 1 && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-xs"
                                  onClick={() => setChangingCurve(true)}
                                >
                                  Edit
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>

                    {runError && (
                      <div className="flex items-start gap-2 p-3 rounded-md border border-destructive/30 bg-destructive/5">
                        <AlertTriangle size={14} className="text-destructive mt-0.5 shrink-0" />
                        <p className="text-sm text-destructive">{runError}</p>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* ════ Right column — Calculation Trace ════════════════════ */}
              {result?.calculation_trace && (
                <div className="w-100 shrink-0 sticky top-0 self-start space-y-4">
                  <CalculationVisuals trace={result.calculation_trace} />
                  <details className="group">
                    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors">
                      Raw JSON
                    </summary>
                    <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                      {JSON.stringify(result.calculation_trace, null, 2)}
                    </pre>
                  </details>
                </div>
              )}
            </div>

            {/* Submit Results button */}
            {result && (
              <div className="px-6 pb-6 pt-4 border-t border-border/60 flex justify-end">
                <Button onClick={() => setView('results')} className="gap-2">
                  Submit Results
                  <ArrowRight size={15} />
                </Button>
              </div>
            )}
          </>
        ) : result ? (
          <SenaiteResultsView
            prep={prep}
            result={result}
            onBack={() => setView('analysis')}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
