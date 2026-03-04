/**
 * SamplePrepHplcFlyout
 *
 * Right-side flyout (Sheet) that processes HPLC data for a single sample prep.
 *
 * Step 1 — Preview: Download PeakData CSV(s) from SharePoint ➜ show purity,
 *           chromatogram, and peak table (with injection tabs).
 * Step 2 — Configure: Select calibration curve; review prep weights.
 * Step 3 — Results: Run analysis, display, saved to history.
 */

import { useState, useEffect, useCallback } from 'react'
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
  ChevronRight,
  CheckCircle2,
  Microscope,
  FlaskConical,
  BarChart3,
  AlertTriangle,
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
  ChromatogramChart,
  parseChromatogramCsv,
  downsampleLTTB,
  type ChromatogramTrace,
} from '@/components/hplc/ChromatogramChart'
import { AnalysisResults } from '@/components/hplc/AnalysisResults'

// ─── Step bar ────────────────────────────────────────────────────────────────

const STEPS = [
  { num: 1, label: 'Preview',   icon: Microscope },
  { num: 2, label: 'Configure', icon: FlaskConical },
  { num: 3, label: 'Results',   icon: BarChart3 },
] as const

type StepNum = 1 | 2 | 3

function StepBar({ current }: { current: StepNum }) {
  return (
    <div className="flex items-center gap-0 mb-6">
      {STEPS.map((s, idx) => {
        const done = s.num < current
        const active = s.num === current
        const Icon = s.icon
        return (
          <div key={s.num} className="flex items-center">
            <div className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
              done   && 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400',
              active && 'text-primary bg-primary/10',
              !done && !active && 'text-muted-foreground',
            )}>
              {done
                ? <CheckCircle2 size={14} className="text-emerald-500" />
                : <Icon size={14} />}
              {s.label}
            </div>
            {idx < STEPS.length - 1 && (
              <ChevronRight size={14} className="text-muted-foreground mx-1" />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Purity banner ────────────────────────────────────────────────────────────

function PurityBanner({ pct }: { pct: number }) {
  const ok = pct >= 98
  return (
    <div className={cn(
      'flex items-center gap-3 px-4 py-3 rounded-lg border mb-4',
      ok
        ? 'border-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-950/20'
        : 'border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20',
    )}>
      <CheckCircle2 size={16} className={ok ? 'text-emerald-500' : 'text-amber-500'} />
      <span className="text-sm font-medium">Purity (preview)</span>
      <span className={cn(
        'ml-auto text-2xl font-bold tabular-nums',
        ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
      )}>
        {pct.toFixed(2)}%
      </span>
    </div>
  )
}

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
  const [step, setStep] = useState<StepNum>(1)

  // Step 1
  const [loading, setLoading] = useState(false)
  const [parseResult, setParseResult] = useState<HPLCParseResult | null>(null)
  const [chromTraces, setChromTraces] = useState<ChromatogramTrace[]>([])
  const [parseError, setParseError] = useState<string | null>(null)
  const [activeInj, setActiveInj] = useState(0)

  // Step 2
  const [calibrations, setCalibrations] = useState<CalibrationCurve[]>([])
  const [calLoading, setCalLoading] = useState(false)
  const [selectedCalId, setSelectedCalId] = useState<number | null>(null)

  // Step 3
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<HPLCAnalysisResult | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  // Reset state on open
  useEffect(() => {
    if (open) {
      setStep(1)
      setParseResult(null)
      setChromTraces([])
      setParseError(null)
      setActiveInj(0)
      setResult(null)
      setRunError(null)
    }
  }, [open, prep.id])

  // ── Step 1: download + parse ──────────────────────────────────────────────

  const loadPeakData = useCallback(async () => {
    if (parseResult) return
    setLoading(true)
    setParseError(null)
    try {
      // Resolve chrom files: use scan result if available, otherwise fetch from folder
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

      // Split by file type
      const peakFileNames = new Set(match.peak_files.map(f => f.name))
      const peakFiles   = downloaded.filter(d => peakFileNames.has(d.filename))
      const chromFiles  = downloaded.filter(d => !peakFileNames.has(d.filename))

      // Parse peak data — content is raw UTF-8 CSV text
      const parsed = await parseHPLCFiles(
        peakFiles.map(d => ({ filename: d.filename, content: d.content }))
      )
      setParseResult(parsed)

      // Build chromatogram traces from dx_dad1a chromatogram files
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
    if (open && step === 1) loadPeakData()
  }, [open, step, loadPeakData])

  // ── Step 2: load calibrations ─────────────────────────────────────────────

  const loadCalibrations = useCallback(async () => {
    if (!prep.peptide_id) return
    setCalLoading(true)
    try {
      const cals = await getCalibrations(prep.peptide_id)
      setCalibrations(cals)
      const active = cals.find(c => c.is_active)
      setSelectedCalId(active?.id ?? cals[0]?.id ?? null)
    } catch { /* non-fatal */ }
    finally { setCalLoading(false) }
  }, [prep.peptide_id])

  useEffect(() => {
    if (open && step === 2) loadCalibrations()
  }, [open, step, loadCalibrations])

  // ── Step 3: run analysis ──────────────────────────────────────────────────

  const runAnalysis = async () => {
    if (!parseResult || !prep.peptide_id) return
    setRunning(true)
    setRunError(null)
    try {
      const res = await runHPLCAnalysis({
        sample_id_label: prep.senaite_sample_id ?? prep.sample_id,
        peptide_id: prep.peptide_id,
        calibration_curve_id: selectedCalId ?? undefined,
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
      setStep(3)
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Analysis failed')
    } finally {
      setRunning(false)
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const injections = parseResult?.injections ?? []
  const activeInjData = injections[activeInj]
  const purity = parseResult?.purity?.purity_percent ?? null
  const selectedCal = calibrations.find(c => c.id === selectedCalId)

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <Sheet open={open} onOpenChange={v => !v && onClose()}>
      <SheetContent
        side="right"
        className="w-[680px] sm:max-w-[680px] overflow-y-auto p-0"
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

        <div className="px-6 py-5">
          <StepBar current={step} />

          {/* ── STEP 1 ──────────────────────────────────────────────────── */}
          {step === 1 && (
            <div className="space-y-5">
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

              {!loading && parseResult && (
                <>
                  {/* Purity */}
                  {purity != null && <PurityBanner pct={purity} />}

                  {/* Injection tabs */}
                  {injections.length > 1 && (
                    <InjectionTabs
                      injections={injections}
                      active={activeInj}
                      onSelect={setActiveInj}
                    />
                  )}

                  {/* Chromatogram */}
                  {chromTraces.length > 0 && (
                    <div>
                      <p className="text-sm font-semibold mb-2">Chromatogram</p>
                      <ChromatogramChart
                        traces={chromTraces}
                        peakRTs={activeInjData?.peaks
                          .filter(p => !p.is_solvent_front)
                          .map(p => p.retention_time)}
                      />
                    </div>
                  )}

                  {/* Peak table */}
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

                  <Button className="w-full mt-2" onClick={() => setStep(2)}>
                    Continue to Configure
                    <ChevronRight size={16} className="ml-1" />
                  </Button>
                </>
              )}
            </div>
          )}

          {/* ── STEP 2 ──────────────────────────────────────────────────── */}
          {step === 2 && (
            <div className="space-y-5">
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

              {/* Calibration selection */}
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
                      The analysis will use the active default.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {calibrations.map(cal => (
                      <button
                        key={cal.id}
                        onClick={() => setSelectedCalId(cal.id)}
                        className={cn(
                          'w-full flex items-start justify-between gap-3 p-3 rounded-md border text-left transition-colors',
                          cal.id === selectedCalId
                            ? 'border-primary/50 bg-primary/5'
                            : 'border-border hover:border-border/80 hover:bg-muted/40',
                        )}
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
                )}
              </div>

              {runError && (
                <div className="flex items-start gap-2 p-3 rounded-md border border-destructive/30 bg-destructive/5">
                  <AlertTriangle size={14} className="text-destructive mt-0.5 shrink-0" />
                  <p className="text-sm text-destructive">{runError}</p>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <Button variant="outline" onClick={() => setStep(1)} className="flex-1">
                  ← Back
                </Button>
                <Button
                  className="flex-1"
                  onClick={runAnalysis}
                  disabled={running || !parseResult}
                >
                  {running
                    ? <><Spinner className="size-3.5 mr-2" /> Running…</>
                    : <>Run Analysis <ChevronRight size={16} className="ml-1" /></>}
                </Button>
              </div>

              {selectedCal && (
                <p className="text-xs text-muted-foreground text-center">
                  Using: {selectedCal.source_filename ?? `Calibration #${selectedCal.id}`}
                </p>
              )}
            </div>
          )}

          {/* ── STEP 3 ──────────────────────────────────────────────────── */}
          {step === 3 && result && (
            <div className="space-y-5">
              <AnalysisResults result={result} chromatograms={chromTraces} />

              <div className="flex gap-3 pt-2">
                <Button variant="outline" onClick={() => setStep(2)} className="flex-1">
                  ← Back
                </Button>
                <Button
                  className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                  onClick={onClose}
                >
                  <CheckCircle2 size={15} className="mr-1.5" />
                  Done — Saved to History
                </Button>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
