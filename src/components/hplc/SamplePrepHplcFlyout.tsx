/**
 * SamplePrepHplcFlyout
 *
 * Right-side flyout (Sheet) that processes HPLC data for a single sample prep.
 *
 * Single scrollable view — analysis runs automatically once data + calibration
 * are loaded. Changing the calibration curve re-runs analysis.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
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
  Terminal,
  X,
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

// ─── Debug Console ────────────────────────────────────────────────────────────

type DebugLevel = 'info' | 'dim' | 'warn' | 'success' | 'error' | 'formula' | 'formula-dim'

interface DebugLine {
  level: DebugLevel
  msg: string
}

function buildDebugLines({
  prep,
  match,
  parseResult,
  activeAnalyte,
  isBlend,
  labelToComponent,
  blendComponents,
  calibrations,
  selectedCal,
  componentCals,
  componentSelectedCalIds,
  result,
  analyteResults,
  injections,
}: {
  prep: SamplePrep
  match: HplcScanMatch
  parseResult: HPLCParseResult | null
  activeAnalyte: string | null
  isBlend: boolean
  labelToComponent: Map<string, { id: number; name: string; abbreviation: string }>
  blendComponents: { id: number; name: string; abbreviation: string }[]
  calibrations: CalibrationCurve[]
  selectedCal: CalibrationCurve | undefined
  componentCals: Map<number, CalibrationCurve[]>
  componentSelectedCalIds: Map<number, number>
  result: HPLCAnalysisResult | null
  analyteResults: Map<string, HPLCAnalysisResult>
  injections: HPLCInjection[]
}): DebugLine[] {
  const lines: DebugLine[] = []
  const push = (level: DebugLevel, msg: string) => lines.push({ level, msg })

  push('dim', '─── Sample Prep ───')
  push('info', `Sample ID: ${prep.senaite_sample_id ?? prep.sample_id}`)
  push('info', `Peptide: ${prep.peptide_name ?? prep.peptide_abbreviation ?? `#${prep.peptide_id}`}`)
  push('info', `Type: ${isBlend ? 'Blend' : 'Single'}`)

  if (isBlend && blendComponents.length > 0) {
    push('dim', `Components: ${blendComponents.map(c => c.abbreviation).join(', ')}`)
  }

  push('dim', '')
  push('dim', '─── SharePoint Match ───')
  push('info', `Folder: ${match.folder_name}`)
  push('info', `Peak files: ${match.peak_files.length}`)
  match.peak_files.forEach(f => push('dim', `  ${f.name}`))
  push('info', `Chrom files: ${match.chrom_files.length}`)
  match.chrom_files.forEach(f => push('dim', `  ${f.name}`))

  if (!parseResult) {
    push('warn', 'No parse result — data not yet loaded')
    return lines
  }

  push('dim', '')
  push('dim', '─── Parse Result ───')
  push('info', `Detected peptides: ${parseResult.detected_peptides.join(', ') || '(none)'}`)
  push('info', `Total injections: ${parseResult.injections.length}`)

  if (isBlend) {
    push('dim', '')
    push('dim', '─── Label → Component Mapping ───')
    for (const label of parseResult.detected_peptides) {
      const comp = labelToComponent.get(label)
      if (comp) {
        push('success', `${label} → ${comp.abbreviation} (id:${comp.id})`)
      } else {
        push('error', `${label} → NO MATCH`)
      }
    }
  }

  // Show detail for the active analyte (or single peptide)
  const currentLabel = isBlend ? activeAnalyte : (parseResult.detected_peptides[0] ?? null)
  if (currentLabel) {
    push('dim', '')
    push('dim', `─── Active Analyte: ${currentLabel} ───`)

    const labelInj = injections.filter(inj => inj.peptide_label === currentLabel)
    push('info', `Injections for ${currentLabel}: ${labelInj.length}`)
    labelInj.forEach(inj => {
      push('dim', `  ${inj.injection_name} — ${inj.peaks.length} peaks, total area: ${inj.total_area.toFixed(1)}, main_peak_index: ${inj.main_peak_index}`)
      inj.peaks.forEach((pk, pi) => {
        const tag = pi === inj.main_peak_index ? ' ◀ MAIN' : ''
        const flags = [
          pk.is_main_peak && 'main',
          pk.is_solvent_front && 'solvent-front',
        ].filter(Boolean).join(', ')
        push(
          pi === inj.main_peak_index ? 'success' : 'dim',
          `    peak[${pi}] RT=${pk.retention_time.toFixed(3)} area=${pk.area.toFixed(1)} (${pk.area_percent.toFixed(2)}%) h=${pk.height.toFixed(1)} [${pk.begin_time.toFixed(3)}–${pk.end_time.toFixed(3)}]${flags ? ` {${flags}}` : ''}${tag}`,
        )
      })
    })
  }

  push('dim', '')
  push('dim', '─── Calibration ───')

  if (isBlend && activeAnalyte) {
    const comp = labelToComponent.get(activeAnalyte)
    if (comp) {
      const cals = componentCals.get(comp.id) ?? []
      const selId = componentSelectedCalIds.get(comp.id)
      const sel = cals.find(c => c.id === selId)
      push('info', `Component: ${comp.abbreviation} — ${cals.length} curve(s) available`)
      if (sel) {
        push('success', `Selected: ${sel.source_filename ?? `#${sel.id}`}`)
        push('dim', `  y = ${sel.slope.toFixed(4)}x + ${sel.intercept.toFixed(4)} · R² = ${sel.r_squared.toFixed(4)}`)
        push('dim', `  Active: ${sel.is_active ? 'yes' : 'no'}`)
      } else {
        push('warn', 'No calibration curve selected')
      }
    }
  } else {
    push('info', `Curves available: ${calibrations.length}`)
    if (selectedCal) {
      push('success', `Selected: ${selectedCal.source_filename ?? `#${selectedCal.id}`}`)
      push('dim', `  y = ${selectedCal.slope.toFixed(4)}x + ${selectedCal.intercept.toFixed(4)} · R² = ${selectedCal.r_squared.toFixed(4)}`)
      push('dim', `  Active: ${selectedCal.is_active ? 'yes' : 'no'}`)
    } else {
      push('warn', 'No calibration curve selected')
    }
  }

  push('dim', '')
  push('dim', '─── Weights ───')
  const wt = (label: string, val: number | null) =>
    push(val != null ? 'info' : 'warn', `${label}: ${val != null ? `${val.toFixed(2)} mg` : 'MISSING'}`)
  wt('Stock vial empty', prep.stock_vial_empty_mg)
  wt('Stock vial loaded', prep.stock_vial_loaded_mg)
  wt('Dil vial empty', prep.dil_vial_empty_mg)
  wt('Dil vial + diluent', prep.dil_vial_with_diluent_mg)
  wt('Dil vial final', prep.dil_vial_final_mg)

  // Results
  const currentResult = isBlend && activeAnalyte
    ? analyteResults.get(activeAnalyte)
    : result

  // ── Formulas section — show equations with actual values ──
  if (currentResult?.calculation_trace) {
    const t = currentResult.calculation_trace as Record<string, Record<string, unknown>>
    const dil = t.dilution ?? {}
    const qty = t.quantity ?? {}
    const pur = t.purity ?? {}
    const ident = t.identity ?? {}

    const fmt = (v: unknown, dp = 4) => v != null ? Number(v).toFixed(dp) : '?'

    push('dim', '')
    push('formula', '─── Formulas (values from this run) ───')

    // Dilution factor
    push('dim', '')
    push('formula', '1. Dilution Factor')
    push('formula-dim', `   diluent_mass  = dil_w_diluent − dil_empty`)
    push('formula', `                 = ${fmt(prep.dil_vial_with_diluent_mg, 2)} − ${fmt(prep.dil_vial_empty_mg, 2)} = ${fmt(dil.diluent_mass_mg)} mg`)
    push('formula-dim', `   diluent_vol   = (diluent_mass / density) × 1000`)
    push('formula', `                 = ${fmt(dil.diluent_vol_ul)} µL`)
    push('formula-dim', `   sample_mass   = dil_final − dil_w_diluent`)
    push('formula', `                 = ${fmt(prep.dil_vial_final_mg, 2)} − ${fmt(prep.dil_vial_with_diluent_mg, 2)} = ${fmt(dil.sample_mass_mg)} mg`)
    push('formula-dim', `   sample_vol    = (sample_mass / density) × 1000`)
    push('formula', `                 = ${fmt(dil.sample_vol_ul)} µL`)
    push('formula-dim', `   total_vol     = diluent_vol + sample_vol`)
    push('formula', `                 = ${fmt(dil.total_vol_ul)} µL`)
    push('formula-dim', `   DF            = total_vol / sample_vol`)
    push('formula', `                 = ${fmt(dil.dilution_factor, 6)}`)

    // Stock volume
    push('dim', '')
    push('formula', '2. Stock Volume')
    push('formula-dim', `   stock_mass    = stock_loaded − stock_empty`)
    push('formula', `                 = ${fmt(prep.stock_vial_loaded_mg, 2)} − ${fmt(prep.stock_vial_empty_mg, 2)} = ${fmt(dil.stock_mass_mg)} mg`)
    push('formula-dim', `   stock_vol     = stock_mass / density`)
    push('formula', `                 = ${fmt(dil.stock_volume_ml, 6)} mL`)

    // Purity
    push('dim', '')
    push('formula', '3. Purity')
    const purVals = pur.individual_values as number[] | undefined
    if (purVals && purVals.length > 0) {
      push('formula-dim', `   main_peak_area%  per injection:`)
      const purNames = (pur.injection_names ?? []) as string[]
      purVals.forEach((v, i) => push('formula', `     ${purNames[i] ?? `inj[${i}]`}: ${Number(v).toFixed(2)}%`))
      push('formula-dim', `   purity         = avg(main_peak_area%)`)
      push('formula', `                 = ${fmt(pur.purity_percent, 2)}%`)
      if (pur.rsd_percent != null) {
        push('formula-dim', `   RSD            = ${fmt(pur.rsd_percent, 2)}%`)
      }
    } else {
      push('warn', `   No main peaks found for purity`)
    }

    // Quantity
    push('dim', '')
    push('formula', '4. Quantity')
    const qtyAreas = qty.individual_areas as number[] | undefined
    if (qtyAreas && qtyAreas.length > 0) {
      push('formula', `   main_peak_areas: [${qtyAreas.map(a => Number(a).toFixed(1)).join(', ')}]`)
      push('formula-dim', `   avg_area       = ${fmt(qty.avg_main_peak_area)}`)
      push('formula-dim', `   Conc           = (avg_area − intercept) / slope`)
      push('formula', `                 = (${fmt(qty.avg_main_peak_area)} − ${fmt(qty.calibration_intercept)}) / ${fmt(qty.calibration_slope)}`)
      push('formula', `                 = ${fmt(qty.concentration_ug_ml)} µg/mL`)
      push('formula-dim', `   undiluted_conc = Conc × DF`)
      push('formula', `                 = ${fmt(qty.concentration_ug_ml)} × ${fmt(qty.dilution_factor, 6)}`)
      push('formula', `                 = ${fmt(qty.undiluted_concentration_ug_ml)} µg/mL`)
      push('formula-dim', `   mass           = undiluted_conc × stock_vol`)
      push('formula', `                 = ${fmt(qty.undiluted_concentration_ug_ml)} × ${fmt(qty.stock_volume_ml, 6)}`)
      push('formula', `                 = ${fmt(qty.mass_ug)} µg`)
      push('formula-dim', `   quantity       = mass / 1000`)
      push('formula', `                 = ${fmt(qty.quantity_mg)} mg`)
    } else {
      push('warn', `   No main peak areas found for quantity`)
    }

    // Identity
    push('dim', '')
    push('formula', '5. Identity')
    if (ident.conforms != null) {
      const indivRts = (ident.individual_rts ?? []) as number[]
      if (indivRts.length > 0) {
        push('formula', `   sample RTs:    [${indivRts.map(r => Number(r).toFixed(3)).join(', ')}]`)
      }
      push('formula-dim', `   avg_sample_RT  = ${fmt(ident.sample_rt, 3)}`)
      push('formula-dim', `   reference_RT   = ${fmt(ident.reference_rt, 3)}`)
      push('formula-dim', `   tolerance      = ±${fmt(ident.rt_tolerance, 3)} min`)
      push('formula-dim', `   |delta|        = |${fmt(ident.sample_rt, 3)} − ${fmt(ident.reference_rt, 3)}| = ${fmt(ident.rt_delta, 3)}`)
      push(
        ident.conforms ? 'success' : 'error',
        `   result         = ${Number(ident.rt_delta) <= Number(ident.rt_tolerance) ? 'CONFORMS' : 'DOES NOT CONFORM'} (${fmt(ident.rt_delta, 3)} ${Number(ident.rt_delta) <= Number(ident.rt_tolerance) ? '≤' : '>'} ${fmt(ident.rt_tolerance, 3)})`,
      )
    } else if (ident.error) {
      push('warn', `   ${ident.error}`)
    } else {
      push('formula-dim', `   No identity data`)
    }
  }

  if (currentResult) {
    push('dim', '')
    push('dim', '─── Analysis Results (Summary) ───')
    push('success', `Purity: ${currentResult.purity_percent != null ? `${currentResult.purity_percent.toFixed(2)}%` : 'N/A'}`)
    push('success', `Quantity: ${currentResult.quantity_mg != null ? `${currentResult.quantity_mg.toFixed(4)} mg` : 'N/A'}`)
    push('success', `Identity: ${currentResult.identity_conforms != null ? (currentResult.identity_conforms ? 'CONFORMS' : 'DOES NOT CONFORM') : 'N/A'}`)

    if (currentResult.calculation_trace) {
      const trace = currentResult.calculation_trace
      push('dim', '')
      push('formula', '─── Raw Calculation Trace ───')
      const printObj = (obj: Record<string, unknown>, indent: number) => {
        for (const [key, val] of Object.entries(obj)) {
          const pad = '  '.repeat(indent)
          if (val == null) {
            push('warn', `${pad}${key}: null`)
          } else if (typeof val === 'object' && !Array.isArray(val)) {
            push('formula', `${pad}${key}:`)
            printObj(val as Record<string, unknown>, indent + 1)
          } else if (Array.isArray(val)) {
            push('formula-dim', `${pad}${key}: [${val.map(v => String(v)).join(', ')}]`)
          } else {
            const isErrorKey = key === 'error' || (typeof val === 'string' && /no |not found|fail|missing/i.test(String(val)))
            push(isErrorKey ? 'error' : 'formula-dim', `${pad}${key}: ${val}`)
          }
        }
      }
      printObj(trace, 1)
    }
  } else {
    push('dim', '')
    push('warn', 'No analysis results yet')
  }

  if (isBlend && analyteResults.size > 0) {
    push('dim', '')
    push('dim', '─── All Analyte Results ───')
    for (const [label, res] of analyteResults.entries()) {
      const tag = label === activeAnalyte ? ' ◀ active' : ''
      push(
        'info',
        `${label}: purity=${res.purity_percent?.toFixed(2) ?? '—'}% qty=${res.quantity_mg?.toFixed(4) ?? '—'} mg${tag}`,
      )
    }
  }

  return lines
}

const debugColorForLevel = (level: DebugLevel) => ({
  info:        'text-zinc-300',
  dim:         'text-zinc-600',
  warn:        'text-amber-400',
  success:     'text-emerald-400',
  error:       'text-red-400',
  'formula':     'text-cyan-300',
  'formula-dim': 'text-cyan-700',
})[level]

function DebugConsole({ lines, onClose }: { lines: DebugLine[]; onClose: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lines])

  return (
    <div className="fixed inset-y-0 right-0 w-340 z-50 flex flex-col bg-black/60 backdrop-blur-sm">
      <div className="m-4 flex flex-1 flex-col rounded-lg overflow-hidden border border-zinc-800/80 shadow-2xl shadow-black/90">
        {/* Title bar */}
        <div className="bg-zinc-900 border-b border-zinc-800/80 px-3 py-2 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex gap-1.5 shrink-0">
              <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
              <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
            </div>
            <span className="text-[11px] text-zinc-500 font-mono truncate">
              <span className="text-zinc-600">$</span> accumark debug-hplc
            </span>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-zinc-600 hover:text-zinc-300 transition-colors"
          >
            <X size={13} />
          </button>
        </div>

        {/* Log lines */}
        <div
          ref={scrollRef}
          className="bg-[#0d0d0d] px-3 py-3 space-y-0.5 flex-1 overflow-y-auto"
        >
          {lines.map((line, i) => (
            <div key={i} className={cn('font-mono text-[11px] leading-tight whitespace-pre-wrap', debugColorForLevel(line.level))}>
              {line.msg}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="bg-[#0a0a0a] border-t border-zinc-900 px-3 py-2 font-mono text-[10px] flex items-center justify-between shrink-0">
          <span className="text-emerald-500/70">
            {lines.filter(l => l.level !== 'dim').length} entries
          </span>
          <span className="text-zinc-700">
            esc to close
          </span>
        </div>
      </div>
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

  // Configure — single peptide
  const [calibrations, setCalibrations] = useState<CalibrationCurve[]>([])
  const [calLoading, setCalLoading] = useState(false)
  const [selectedCalId, setSelectedCalId] = useState<number | null>(null)
  const [changingCurve, setChangingCurve] = useState(false)

  // Configure — blend: per-component calibration curves
  const [componentCals, setComponentCals] = useState<Map<number, CalibrationCurve[]>>(new Map())
  const [componentSelectedCalIds, setComponentSelectedCalIds] = useState<Map<number, number>>(new Map())

  // Analysis
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<HPLCAnalysisResult | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  // Blend support — per-analyte results
  const [activeAnalyte, setActiveAnalyte] = useState<string | null>(null)
  const [analyteResults, setAnalyteResults] = useState<Map<string, HPLCAnalysisResult>>(new Map())

  // View toggle
  const [view, setView] = useState<'analysis' | 'results'>('analysis')

  // Debug console overlay
  const [showDebug, setShowDebug] = useState(false)

  useEffect(() => {
    if (!showDebug) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setShowDebug(false) }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [showDebug])

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
      setActiveAnalyte(null)
      setAnalyteResults(new Map())
      setComponentCals(new Map())
      setComponentSelectedCalIds(new Map())
      setView('analysis')
      setShowDebug(false)
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

  // ── Blend detection ────────────────────────────────────────────────────────

  const isBlend = prep.is_blend && (prep.components_json?.length ?? 0) > 0
  const blendComponents = useMemo(
    () => prep.components_json ?? [],
    [prep.components_json],
  )

  // Parsed HPLC labels (short names from filenames, e.g. "BPC", "TB500(17-23)")
  const parsedLabels = useMemo(
    () => parseResult?.detected_peptides ?? [],
    [parseResult?.detected_peptides],
  )

  // For blends: map parsed short labels → component objects via prefix match
  // e.g. "BPC157" matches "BPC-157", "GHK" matches "GHK-CU"
  const labelToComponent = useMemo(() => {
    if (!isBlend) return new Map<string, typeof blendComponents[0]>()
    const map = new Map<string, typeof blendComponents[0]>()
    // Normalize: strip dashes/hyphens/spaces for comparison
    const norm = (s: string) => s.toUpperCase().replace(/[-\s]/g, '')
    for (const label of parsedLabels) {
      const upper = label.toUpperCase()
      const normalized = norm(label)
      // Try exact match, then normalized match, then prefix/contains
      const comp = blendComponents.find(c => c.abbreviation.toUpperCase() === upper)
        ?? blendComponents.find(c => norm(c.abbreviation) === normalized)
        ?? blendComponents.find(c => norm(c.abbreviation).startsWith(normalized))
        ?? blendComponents.find(c => normalized.startsWith(norm(c.abbreviation)))
        ?? blendComponents.find(c => upper.startsWith(c.abbreviation.toUpperCase().split(' ')[0] ?? ''))
      if (comp) map.set(label, comp)
    }
    return map
  }, [isBlend, blendComponents, parsedLabels])

  // Use parsed labels as tab keys (they match the actual injection data)
  const blendPeptides = useMemo(
    () => isBlend ? parsedLabels : parsedLabels,
    [isBlend, parsedLabels],
  )
  const hasMultipleAnalytes = blendPeptides.length > 1

  // ── Load calibrations ───────────────────────────────────────────────────────

  const loadCalibrations = useCallback(async () => {
    if (!prep.peptide_id) return
    setCalLoading(true)
    try {
      if (isBlend) {
        // Load calibrations per component peptide
        const calsMap = new Map<number, CalibrationCurve[]>()
        const selectedMap = new Map<number, number>()
        for (const comp of blendComponents) {
          const cals = await getCalibrations(comp.id)
          calsMap.set(comp.id, cals)
          const active = cals.find(c => c.is_active)
          if (active) selectedMap.set(comp.id, active.id)
          else if (cals[0]) selectedMap.set(comp.id, cals[0].id)
        }
        setComponentCals(calsMap)
        setComponentSelectedCalIds(selectedMap)
        // Also set the flat calibrations/selectedCalId for the first component
        // so the UI has something to display initially
        const firstComp = blendComponents[0]
        if (firstComp) {
          const firstCals = calsMap.get(firstComp.id) ?? []
          setCalibrations(firstCals)
          setSelectedCalId(selectedMap.get(firstComp.id) ?? null)
        }
      } else {
        const cals = await getCalibrations(prep.peptide_id)
        setCalibrations(cals)
        const active = cals.find(c => c.is_active)
        setSelectedCalId(active?.id ?? cals[0]?.id ?? null)
      }
      setChangingCurve(false)
    } catch { /* non-fatal */ }
    finally { setCalLoading(false) }
  }, [prep.peptide_id, isBlend, blendComponents])

  useEffect(() => {
    if (open) loadCalibrations()
  }, [open, loadCalibrations])

  // ── Run analysis (auto-triggered) ──────────────────────────────────────────

  // For blends: check all matched components have a selected calibration
  const allBlendCalsReady = isBlend
    ? [...labelToComponent.values()].every(c => componentSelectedCalIds.has(c.id))
    : true

  const runAllAnalyses = useCallback(async () => {
    if (!parseResult || !prep.peptide_id) return
    // For non-blend, need selectedCalId; for blend, need per-component cal IDs
    if (!isBlend && !selectedCalId) return
    if (isBlend && !allBlendCalsReady) return

    setRunning(true)
    setRunError(null)

    const weights = {
      stock_vial_empty:                 prep.stock_vial_empty_mg   ?? 0,
      stock_vial_with_diluent:          prep.stock_vial_loaded_mg  ?? 0,
      dil_vial_empty:                   prep.dil_vial_empty_mg     ?? 0,
      dil_vial_with_diluent:            prep.dil_vial_with_diluent_mg ?? 0,
      dil_vial_with_diluent_and_sample: prep.dil_vial_final_mg     ?? 0,
    }

    const results = new Map<string, HPLCAnalysisResult>()

    try {
      if (isBlend) {
        // Run analysis per component using parsed label → component mapping
        for (const [label, comp] of labelToComponent.entries()) {
          const calId = componentSelectedCalIds.get(comp.id)
          if (!calId) continue
          const filteredInj = parseResult.injections.filter(
            inj => inj.peptide_label === label
          )
          if (filteredInj.length === 0) continue

          const res = await runHPLCAnalysis({
            sample_id_label: prep.senaite_sample_id ?? prep.sample_id,
            peptide_id: comp.id,
            calibration_curve_id: calId,
            weights,
            injections: filteredInj as unknown as Record<string, unknown>[],
          })
          results.set(label, res)
        }
      } else {
        // Single peptide — original behavior
        const peptideLabels = hasMultipleAnalytes ? blendPeptides : [null as string | null]
        for (const label of peptideLabels) {
          const filteredInj = label
            ? parseResult.injections.filter(inj => inj.peptide_label === label)
            : parseResult.injections

          const res = await runHPLCAnalysis({
            sample_id_label: prep.senaite_sample_id ?? prep.sample_id,
            peptide_id: prep.peptide_id,
            calibration_curve_id: selectedCalId ?? 0,
            weights,
            injections: filteredInj as unknown as Record<string, unknown>[],
          })
          results.set(label ?? '__single__', res)
        }
      }

      setAnalyteResults(results)

      if (!hasMultipleAnalytes && !isBlend) {
        setResult(results.get('__single__') ?? null)
      } else {
        // Pick the first label that actually has a result (not all labels may
        // have matched a component / produced results)
        const firstWithResult = blendPeptides.find(l => results.has(l)) ?? null
        const fallbackResult = firstWithResult !== null ? (results.get(firstWithResult) ?? null) : null
        setResult(fallbackResult)
        setActiveAnalyte(firstWithResult ?? blendPeptides[0] ?? null)
      }
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Analysis failed')
    } finally {
      setRunning(false)
    }
  }, [parseResult, prep, selectedCalId, isBlend, hasMultipleAnalytes, blendPeptides, labelToComponent, componentSelectedCalIds, allBlendCalsReady])

  // Auto-run when peak data + calibration are both ready
  useEffect(() => {
    const calsReady = isBlend ? allBlendCalsReady : !!selectedCalId
    if (parseResult && calsReady && prep.peptide_id && !result && !running && !runError) {
      runAllAnalyses()
    }
  }, [parseResult, selectedCalId, allBlendCalsReady, isBlend, prep.peptide_id, result, running, runError, runAllAnalyses])

  // ── Derived ─────────────────────────────────────────────────────────────────

  const injections = parseResult?.injections ?? []
  const selectedCal = calibrations.find(c => c.id === selectedCalId)

  // For blends, show only the active analyte's injections
  const displayInjections = (isBlend || hasMultipleAnalytes) && activeAnalyte
    ? injections.filter(inj => inj.peptide_label === activeAnalyte)
    : injections
  const activeInjData = displayInjections[activeInj]

  // For blends: filter chromatogram traces to the active analyte
  // Chrom filenames contain analyte labels, e.g. "PB-0051_Inj_1_GHK.dx_DAD1A"
  // or combined "PB-0051_Inj_1_KPV_BPC_TB500.dx_DAD1A"
  const displayChromTraces = useMemo(() => {
    if (!activeAnalyte || !hasMultipleAnalytes) return chromTraces
    // Exclude blanks, then keep traces whose name contains the active label
    const upper = activeAnalyte.toUpperCase()
    const filtered = chromTraces.filter(t => {
      const n = t.name.toUpperCase()
      if (n.includes('BLANK')) return false
      return n.includes(upper)
    })
    // If no specific match, fall back to all non-blank traces
    return filtered.length > 0
      ? filtered
      : chromTraces.filter(t => !t.name.toUpperCase().includes('BLANK'))
  }, [chromTraces, activeAnalyte, hasMultipleAnalytes])

  // Switch analyte tab — also swap displayed calibrations for blends
  const handleAnalyteChange = useCallback((label: string) => {
    setActiveAnalyte(label)
    setActiveInj(0)
    const r = analyteResults.get(label)
    if (r) setResult(r)
    // For blends: update the visible calibration list to match this component
    if (isBlend) {
      const comp = labelToComponent.get(label)
      if (comp) {
        setCalibrations(componentCals.get(comp.id) ?? [])
        setSelectedCalId(componentSelectedCalIds.get(comp.id) ?? null)
      }
    }
  }, [analyteResults, isBlend, labelToComponent, componentCals, componentSelectedCalIds])

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
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-base font-semibold truncate">
                Process HPLC — {prep.senaite_sample_id ?? prep.sample_id}
              </SheetTitle>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {match.folder_name}
              </p>
            </div>
            <button
              onClick={() => setShowDebug(v => !v)}
              className={cn(
                'shrink-0 p-2 rounded-md border transition-colors',
                showDebug
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-500'
                  : 'border-border/60 text-muted-foreground hover:text-foreground hover:border-border',
              )}
              title="Debug console"
            >
              <Terminal size={15} />
            </button>
          </div>
        </SheetHeader>

        {/* Debug console overlay */}
        {showDebug && (
          <DebugConsole
            lines={buildDebugLines({
              prep,
              match,
              parseResult,
              activeAnalyte,
              isBlend,
              labelToComponent,
              blendComponents,
              calibrations,
              selectedCal,
              componentCals,
              componentSelectedCalIds,
              result,
              analyteResults,
              injections,
            })}
            onClose={() => setShowDebug(false)}
          />
        )}

        {view === 'analysis' ? (
          <>
            {/* Analyte tabs for blends / multi-analyte */}
            {hasMultipleAnalytes && result && (
              <div className="px-6 pt-4 pb-0">
                <div className="flex gap-1.5">
                  {blendPeptides.map(label => (
                    <button
                      key={label}
                      onClick={() => handleAnalyteChange(label)}
                      className={cn(
                        'px-3 py-1.5 text-xs font-medium rounded-md border transition-colors',
                        activeAnalyte === label
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background border-border hover:bg-muted',
                      )}
                    >
                      {label}
                      {analyteResults.has(label) && (
                        <CheckCircle2 size={12} className="ml-1.5 inline" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-6 px-6 py-5">
              {/* ════ Left column — results + data ════════════════════════ */}
              <div className="flex-1 min-w-0 space-y-5">
                {/* Analysis results */}
                {running && (
                  <div className="flex flex-col items-center gap-3 py-8">
                    <Spinner className="size-6" />
                    <p className="text-sm text-muted-foreground">
                      Running analysis{hasMultipleAnalytes ? ` (${blendPeptides.length} analytes)` : ''}…
                    </p>
                  </div>
                )}
                {result && (
                  <>
                    <AnalysisResults result={result} chromatograms={displayChromTraces} hideTrace />

                    {/* Peak table right under the chromatogram */}
                    {displayInjections.length > 1 && (
                      <InjectionTabs
                        injections={displayInjections}
                        active={activeInj}
                        onSelect={setActiveInj}
                      />
                    )}
                    {activeInjData && activeInjData.peaks.length > 0 && (
                      <div>
                        <p className="text-sm font-semibold mb-2">
                          Peak Data
                          {displayInjections.length > 1 && (
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
                              onClick={() => { setSelectedCalId(cal.id); setChangingCurve(false); setResult(null); setAnalyteResults(new Map()); setRunError(null) }}
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
            results={isBlend || hasMultipleAnalytes ? [...analyteResults.values()] : [result]}
            onBack={() => setView('analysis')}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
