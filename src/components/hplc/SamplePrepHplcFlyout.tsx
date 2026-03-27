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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  CheckCircle2,
  Microscope,
  AlertTriangle,
  ArrowRight,
  Terminal,
  ExternalLink,
  Plus,
  X,
} from 'lucide-react'
import {
  downloadSharePointFiles,
  parseHPLCFiles,
  getCalibrations,
  runHPLCAnalysis,
  getFolderChromFiles,
  getHPLCAnalysesBySamplePrep,
  updateSamplePrep,
  sha256Hex,
  type SamplePrep,
  type HplcScanMatch,
  type CalibrationCurve,
  type HPLCParseResult,
  type HPLCInjection,
  type HPLCAnalysisResult,
  type ComponentBrief,
  type PeptideRecord,
  getPeptides,
  updatePeptide,
} from '@/lib/api'
import { PeakTable } from '@/components/hplc/PeakTable'
import {
  parseChromatogramCsv,
  downsampleLTTB,
  extractStandardTrace,
  type ChromatogramTrace,
} from '@/components/hplc/ChromatogramChart'
import { AnalysisResults } from '@/components/hplc/AnalysisResults'
import { CalculationVisuals } from '@/components/hplc/CalculationVisuals'
import { SenaiteResultsView } from '@/components/hplc/SenaiteResultsView'
import { StandardCurveReview } from '@/components/hplc/StandardCurveReview'
import { useAuthStore } from '@/store/auth-store'
import { User, Cpu } from 'lucide-react'

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
  parseError,
}: {
  prep: SamplePrep
  match: HplcScanMatch
  parseResult: HPLCParseResult | null
  activeAnalyte: string | null
  isBlend: boolean
  labelToComponent: Map<string, ComponentBrief>
  blendComponents: ComponentBrief[]
  calibrations: CalibrationCurve[]
  selectedCal: CalibrationCurve | undefined
  componentCals: Map<number, CalibrationCurve[]>
  componentSelectedCalIds: Map<number, number>
  result: HPLCAnalysisResult | null
  analyteResults: Map<string, HPLCAnalysisResult>
  injections: HPLCInjection[]
  parseError?: string | null
}): DebugLine[] {
  const lines: DebugLine[] = []
  const push = (level: DebugLevel, msg: string) => lines.push({ level, msg })

  // 5. SharePoint download errors
  if (parseError) {
    push('warn', `SharePoint download error: ${parseError}`)
  }

  push('dim', '─── Sample Prep ───')
  push('info', `Sample ID: ${prep.senaite_sample_id ?? prep.sample_id}`)
  push('info', `Peptide: ${prep.peptide_name ?? prep.peptide_abbreviation ?? `#${prep.peptide_id}`}`)
  push('info', `Type: ${isBlend ? 'Blend' : 'Single'}`)
  push('info', `is_standard (DB): ${prep.is_standard}`)

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
    const norm = (s: string) => s.toUpperCase().replace(/[-\s()]/g, '')
    for (const label of parseResult.detected_peptides) {
      const comp = labelToComponent.get(label)
      if (comp) {
        push('success', `${label} → ${comp.abbreviation} (id:${comp.id})`)
      } else {
        push('error', `${label} (normalized: "${norm(label)}") → NO MATCH`)
        // Show what was checked against
        for (const c of blendComponents) {
          const aliases = c.hplc_aliases
          push('warn', `  vs ${c.abbreviation} (norm: "${norm(c.abbreviation)}", aliases: ${aliases?.length ? aliases.join(', ') : 'none'})`)
        }
      }
    }

    // Standard injections
    if (parseResult.standard_injections?.length) {
      push('dim', '')
      push('dim', '─── Standard Injections ───')
      for (const si of parseResult.standard_injections) {
        push('info', `${si.analyte_label}: RT=${si.main_peak_rt.toFixed(3)} min (Area%=${si.main_peak_area_pct.toFixed(1)}%) source=${si.source_sample_id}`)
      }
    } else {
      push('dim', '')
      push('warn', '─── Standard Injections: NONE FOUND ───')
    }

    // 1. Warn for each blend component with no matching standard injection
    for (const [label, comp] of labelToComponent.entries()) {
      const hasStdInj = parseResult.standard_injections?.some(
        si => si.analyte_label === label
      )
      if (!hasStdInj) {
        push('warn', `No standard injection found for ${comp.abbreviation} (label: ${label}) — identity will use calibration curve RT`)
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

  // 2. Missing chromatogram CSV files
  push('dim', '')
  push('dim', '─── Chromatogram Availability ───')
  if (match.chrom_files.length === 0) {
    push('warn', 'No chromatogram CSV files found in SharePoint folder')
  } else {
    push('info', `Chromatogram files: ${match.chrom_files.length}`)
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

  if (isBlend && prep.vial_data && prep.vial_data.length > 0) {
    // Show per-vial weights for blends
    for (const vd of prep.vial_data) {
      const compNames = vd.component_abbreviations?.join(', ') ?? `Vial ${vd.vial_number}`
      push('dim', `Vial ${vd.vial_number} (${compNames}):`)
      wt('  Stock vial empty', vd.stock_vial_empty_mg)
      wt('  Stock vial loaded', vd.stock_vial_loaded_mg)
      wt('  Dil vial empty', vd.dil_vial_empty_mg)
      wt('  Dil vial + diluent', vd.dil_vial_with_diluent_mg)
      wt('  Dil vial final', vd.dil_vial_final_mg)
    }
    // 4. Warn for blend components with no matching vial weight entry
    if (labelToComponent.size > 0) {
      for (const [label, comp] of labelToComponent.entries()) {
        const compBrief = blendComponents.find(c => c.id === comp.id)
        const vialNum = compBrief?.vial_number ?? 1
        const hasVial = prep.vial_data.some(v => v.vial_number === vialNum)
        if (!hasVial) {
          push('warn', `No vial weight data for ${comp.abbreviation} (label: ${label}, expected vial ${vialNum})`)
        }
      }
    }
  } else {
    if (isBlend && (!prep.vial_data || prep.vial_data.length === 0)) {
      push('warn', 'No per-vial weight data — using top-level weights for all analytes')
    }
    wt('Stock vial empty', prep.stock_vial_empty_mg)
    wt('Stock vial loaded', prep.stock_vial_loaded_mg)
    wt('Dil vial empty', prep.dil_vial_empty_mg)
    wt('Dil vial + diluent', prep.dil_vial_with_diluent_mg)
    wt('Dil vial final', prep.dil_vial_final_mg)
  }

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

    // 3. Identity reference source: warn if calibration curve fallback, confirm if standard injection
    if (currentResult?.identity_reference_source === 'calibration_curve') {
      push('warn', `Identity RT reference from calibration curve (no standard injection available)`)
    } else if (currentResult?.identity_reference_source === 'standard_injection') {
      push('success', `Identity RT reference from standard injection (${currentResult.identity_reference_source_id ?? 'unknown'})`)
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
  const authUser = useAuthStore(state => state.user)
  // Phase 13.5: Archive downloaded file contents for audit trail
  const downloadedFilesRef = useRef<{ filename: string; content: string }[]>([])

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

  // Standard curve creation success
  const [standardCurveCreated, setStandardCurveCreated] = useState(false)

  // Debug console overlay
  const [showDebug, setShowDebug] = useState(false)

  // Add-alias modal state
  const [aliasModalLabel, setAliasModalLabel] = useState<string | null>(null)
  const [aliasModalPeptideId, setAliasModalPeptideId] = useState<string>('')
  const [aliasModalPeptides, setAliasModalPeptides] = useState<PeptideRecord[]>([])
  const [aliasModalSaving, setAliasModalSaving] = useState(false)

  // Saved results from DB (loaded on flyout open)
  const [savedResults, setSavedResults] = useState<HPLCAnalysisResult[] | null>(null)
  const [loadingSaved, setLoadingSaved] = useState(false)
  // Ref guard — synchronous, prevents race between DB check and SharePoint scan effects
  const dbCheckActiveRef = useRef(false)

  useEffect(() => {
    if (!showDebug) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setShowDebug(false) }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [showDebug])

  // Reset state on open + async DB check for saved results
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
      setStandardCurveCreated(false)
      setShowDebug(false)
      setSavedResults(null)

      // Set ref SYNCHRONOUSLY so the SharePoint effect (which fires in the same
      // commit cycle) sees it immediately — state updates won't be visible yet
      dbCheckActiveRef.current = true

      // Async DB check — load saved results before SharePoint scan
      ;(async () => {
        setLoadingSaved(true)
        try {
          const allSaved = await getHPLCAnalysesBySamplePrep(prep.id)
          if (allSaved.length > 0) {
            // Filter to latest run group only (most recent run_group_id, or most recent created_at)
            const latestGroupId = allSaved[0]?.run_group_id
            const saved = latestGroupId
              ? allSaved.filter(s => s.run_group_id === latestGroupId)
              : allSaved.slice(0, 1) // no group — just take the most recent single result

            setSavedResults(saved)
            const resMap = new Map<string, HPLCAnalysisResult>()
            for (const s of saved) {
              const key = s.peptide_abbreviation ?? '__single__'
              if (!resMap.has(key)) resMap.set(key, s) // deduplicate by abbreviation
            }
            setAnalyteResults(resMap)
            const firstKey = resMap.keys().next().value ?? '__single__'
            setResult(resMap.get(firstKey) ?? null)
            if (resMap.size > 1) setActiveAnalyte(firstKey)
          }
        } catch {
          // DB check failed — savedResults stays null, SharePoint flow proceeds
        } finally {
          setLoadingSaved(false)
          dbCheckActiveRef.current = false
        }
      })()
    }
  }, [open, prep.id])

  // ── Download + parse peak data ──────────────────────────────────────────────

  const loadPeakData = useCallback(async () => {
    if (parseResult) return
    // Wait for DB check to complete before deciding whether to load SharePoint
    if (loadingSaved) return              // skip while DB check still in progress (state)
    if (dbCheckActiveRef.current) return  // skip during DB check (ref — synchronous guard)

    // History mode: no SharePoint files — reconstruct from stored analysis data
    const isHistoryMode = match.peak_files.length === 0 && !match.folder_id
    if (isHistoryMode && savedResults && savedResults.length > 0) {
      setLoading(true)
      try {
        // Reconstruct injections from raw_data
        const allInjections: HPLCInjection[] = []
        for (const sr of savedResults) {
          const rawInj = (sr.raw_data as Record<string, unknown>)?.injections
          if (Array.isArray(rawInj)) {
            allInjections.push(...(rawInj as HPLCInjection[]))
          }
        }
        if (allInjections.length > 0) {
          setParseResult({
            injections: allInjections,
            purity: { purity_percent: null, individual_values: [], injection_names: [], rsd_percent: null },
            errors: [],
            warnings: [],
            detected_peptides: [],
            standard_injections: [],
          })
        }

        // Reconstruct chromatogram traces from stored chromatogram_data
        const traces: ChromatogramTrace[] = []
        for (const sr of savedResults) {
          const cd = sr.chromatogram_data
          if (cd?.times && cd?.signals) {
            const points: [number, number][] = cd.times.map((t: number, i: number) => [t, cd.signals[i] ?? 0])
            traces.push({
              name: sr.peptide_abbreviation ?? sr.sample_id_label,
              points,
            })
          }
        }
        setChromTraces(traces)
      } catch (e) {
        setParseError(e instanceof Error ? e.message : 'Failed to load stored HPLC data')
      } finally {
        setLoading(false)
      }
      return
    }

    // Live mode: download from SharePoint
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

      // Phase 13.5: Archive all downloaded files for source-file audit trail
      downloadedFilesRef.current = downloaded.map(d => ({ filename: d.filename, content: d.content }))

      const peakFileNames = new Set(match.peak_files.map(f => f.name))
      const peakFiles   = downloaded.filter(d => peakFileNames.has(d.filename))
      const chromFiles  = downloaded.filter(d => !peakFileNames.has(d.filename))

      const parsed = await parseHPLCFiles(
        peakFiles.map(d => ({ filename: d.filename, content: d.content }))
      )
      setParseResult(parsed)

      if (parsed.standard_injections?.length) {
        console.log(
          `[HPLC] Found ${parsed.standard_injections.length} standard injection(s):`,
          parsed.standard_injections.map(si => `${si.analyte_label} RT=${si.main_peak_rt} (${si.source_sample_id})`)
        )
      }

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
  }, [match, parseResult, loadingSaved, savedResults])

  useEffect(() => {
    if (open) loadPeakData()
  }, [open, loadPeakData])

  // ── Standard detection ─────────────────────────────────────────────────────

  const isStandard = prep.is_standard === true

  // ── Blend detection ────────────────────────────────────────────────────────

  const isBlend = prep.is_blend && (prep.components_json?.length ?? 0) > 0

  // Blend components — enriched with live hplc_aliases from peptide records
  const [liveAliasMap, setLiveAliasMap] = useState<Map<number, string[]>>(new Map())
  useEffect(() => {
    if (!isBlend || !open) return
    // Fetch live peptide data to get current aliases (components_json may be stale)
    getPeptides().then(peps => {
      const map = new Map<number, string[]>()
      for (const p of peps) {
        if (p.hplc_aliases?.length) map.set(p.id, p.hplc_aliases)
      }
      setLiveAliasMap(map)
    }).catch(() => { /* non-critical */ })
  }, [isBlend, open])

  const blendComponents = useMemo(() => {
    const comps = prep.components_json ?? []
    // Merge live aliases into components (covers stale components_json)
    if (liveAliasMap.size === 0) return comps
    return comps.map(c => ({
      ...c,
      hplc_aliases: liveAliasMap.get(c.id) ?? c.hplc_aliases ?? null,
    }))
  }, [prep.components_json, liveAliasMap],
  )

  // Parsed HPLC labels (short names from filenames, e.g. "BPC", "TB500(17-23)")
  // When loading from DB (no parseResult), derive labels from saved results abbreviations
  // When saved results exist, prefer DB labels even after SharePoint loads — they match
  // the analyteResults map keys. Only switch to parseResult labels when no saved results
  // (fresh run or after Re-run clears savedResults).
  const parsedLabels = useMemo(() => {
    // If we have saved results, use their abbreviations as tab labels (stable, matches map keys)
    if (savedResults && savedResults.length > 0) {
      const unique = [...new Set(savedResults.map(s => s.peptide_abbreviation).filter(Boolean))]
      if (unique.length > 0) return unique as string[]
    }
    // Otherwise use parseResult labels (fresh run from SharePoint)
    if (parseResult?.detected_peptides?.length) return parseResult.detected_peptides
    return []
  }, [parseResult?.detected_peptides, savedResults])

  // For blends: map parsed short labels → component objects
  // Checks: abbreviation, name, and hplc_aliases (stored on peptide record)
  const labelToComponent = useMemo(() => {
    if (!isBlend) return new Map<string, typeof blendComponents[0]>()
    const map = new Map<string, typeof blendComponents[0]>()
    const norm = (s: string) => s.toUpperCase().replace(/[-\s()]/g, '')

    for (const label of parsedLabels) {
      const normalized = norm(label)

      // 1. Check hplc_aliases first (exact match, user-curated — most reliable)
      const aliasMatch = blendComponents.find(c =>
        c.hplc_aliases?.some(a => norm(a) === normalized)
      )
      if (aliasMatch) { map.set(label, aliasMatch); console.log(`[HPLC] Label "${label}" → ${aliasMatch.abbreviation} (via alias)`); continue }

      // 2. Exact abbreviation match (normalized)
      const abbrMatch = blendComponents.find(c => norm(c.abbreviation) === normalized)
      if (abbrMatch) { map.set(label, abbrMatch); console.log(`[HPLC] Label "${label}" → ${abbrMatch.abbreviation} (exact abbrev)`); continue }

      // 3. Name match (normalized)
      const nameMatch = blendComponents.find(c => norm(c.name) === normalized)
      if (nameMatch) { map.set(label, nameMatch); console.log(`[HPLC] Label "${label}" → ${nameMatch.abbreviation} (name match)`); continue }

      // 4. Prefix/contains on abbreviation
      const prefixMatch = blendComponents.find(c => norm(c.abbreviation).startsWith(normalized))
        ?? blendComponents.find(c => normalized.startsWith(norm(c.abbreviation)))
      if (prefixMatch) { map.set(label, prefixMatch); console.log(`[HPLC] Label "${label}" → ${prefixMatch.abbreviation} (prefix)`); continue }

      // 5. Prefix/contains on name
      const namePrefix = blendComponents.find(c => norm(c.name).includes(normalized))
        ?? blendComponents.find(c => normalized.includes(norm(c.name)))
      if (namePrefix) { map.set(label, namePrefix); console.log(`[HPLC] Label "${label}" → ${namePrefix.abbreviation} (name prefix)`); continue }

      // No match found — log warning with full detail
      console.warn(`[HPLC] Label "${label}" (normalized: "${normalized}") — NO MATCH. Components:`,
        blendComponents.map(c => ({
          abbrev: c.abbreviation,
          hplc_aliases: c.hplc_aliases,
          keys: Object.keys(c),
        })))
    }
    console.log(`[HPLC] labelToComponent: ${map.size}/${parsedLabels.length} labels matched`)
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

    // Phase 10.5: provenance — shared across all API calls in this run
    const runGroupId = crypto.randomUUID()
    // Convert ChromatogramTrace[] → { times, signals } for persistence
    const firstTrace = chromTraces[0]
    const chromData = firstTrace != null
      ? {
          times:   firstTrace.points.map(p => p[0]),
          signals: firstTrace.points.map(p => p[1]),
        }
      : undefined

    const defaultWeights = {
      stock_vial_empty:                 prep.stock_vial_empty_mg   ?? 0,
      stock_vial_with_diluent:          prep.stock_vial_loaded_mg  ?? 0,
      dil_vial_empty:                   prep.dil_vial_empty_mg     ?? 0,
      dil_vial_with_diluent:            prep.dil_vial_with_diluent_mg ?? 0,
      dil_vial_with_diluent_and_sample: prep.dil_vial_final_mg     ?? 0,
    }

    // Phase 13: build standard injection RT lookup from parse result
    const stdInjRts: Record<string, { rt: number; source_sample_id: string }> | undefined =
      parseResult.standard_injections && parseResult.standard_injections.length > 0
        ? Object.fromEntries(
            parseResult.standard_injections.map(si => [
              si.analyte_label,
              { rt: si.main_peak_rt, source_sample_id: si.source_sample_id },
            ])
          )
        : undefined

    const results = new Map<string, HPLCAnalysisResult>()

    // Phase 13.5: Compute SHA256 checksums for source file audit trail
    const sourceFiles = downloadedFilesRef.current.length > 0
      ? await Promise.all(
          downloadedFilesRef.current.map(async f => ({
            filename: f.filename,
            content: f.content,
            sha256: await sha256Hex(f.content),
          }))
        )
      : undefined

    // Phase 13.5: Build pre-analysis debug log (captures prep, parse, calibration state
    // before any results exist — this is exactly what you need for post-hoc debugging)
    const preAnalysisDebugLog = buildDebugLines({
      prep, match, parseResult, activeAnalyte: blendPeptides[0] ?? null,
      isBlend, labelToComponent, blendComponents,
      calibrations, selectedCal: calibrations.find(c => c.id === selectedCalId),
      componentCals, componentSelectedCalIds,
      result: null,
      analyteResults: new Map(),
      injections: parseResult.injections,
      parseError,
    })

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

          // Per-vial weight routing: find this component's vial in vial_data
          let weights = defaultWeights
          if (prep.vial_data && prep.vial_data.length > 0) {
            const compBrief = blendComponents.find(c => c.id === comp.id)
            const vialNum = compBrief?.vial_number ?? 1
            const vial = prep.vial_data.find(v => v.vial_number === vialNum)
            if (vial) {
              weights = {
                stock_vial_empty:                 vial.stock_vial_empty_mg   ?? 0,
                stock_vial_with_diluent:          vial.stock_vial_loaded_mg  ?? 0,
                dil_vial_empty:                   vial.dil_vial_empty_mg     ?? 0,
                dil_vial_with_diluent:            vial.dil_vial_with_diluent_mg ?? 0,
                dil_vial_with_diluent_and_sample: vial.dil_vial_final_mg     ?? 0,
              }
            }
          }

          const res = await runHPLCAnalysis({
            sample_id_label: prep.senaite_sample_id ?? prep.sample_id,
            peptide_id: comp.id,
            calibration_curve_id: calId,
            weights,
            injections: filteredInj as unknown as Record<string, unknown>[],
            // Phase 10.5: provenance
            sample_prep_id: prep.id,
            instrument_id: prep.instrument_id ?? undefined,
            source_sharepoint_folder: match.folder_name,
            chromatogram_data: chromData,
            run_group_id: runGroupId,
            // Phase 13: standard injection RTs for same-method identity check
            standard_injection_rts: stdInjRts,
            // Phase 13.5: audit trail
            debug_log: preAnalysisDebugLog,
            source_files: sourceFiles,
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
            weights: defaultWeights,
            injections: filteredInj as unknown as Record<string, unknown>[],
            // Phase 10.5: provenance
            sample_prep_id: prep.id,
            instrument_id: prep.instrument_id ?? undefined,
            source_sharepoint_folder: match.folder_name,
            chromatogram_data: chromData,
            run_group_id: runGroupId,
            // Phase 13: standard injection RTs for same-method identity check
            standard_injection_rts: stdInjRts,
            // Phase 13.5: audit trail
            debug_log: preAnalysisDebugLog,
            source_files: sourceFiles,
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
  }, [parseResult, prep, selectedCalId, isBlend, hasMultipleAnalytes, blendPeptides, labelToComponent, blendComponents, componentSelectedCalIds, allBlendCalsReady, chromTraces, match, calibrations, componentCals, parseError])

  // Auto-run when peak data + calibration are both ready
  useEffect(() => {
    if (isStandard) return // Standards create calibration curves — don't auto-run analysis
    const calsReady = isBlend ? allBlendCalsReady : !!selectedCalId
    if (parseResult && calsReady && prep.peptide_id && !result && !running && !runError) {
      runAllAnalyses()
    }
  }, [isStandard, parseResult, selectedCalId, allBlendCalsReady, isBlend, prep.peptide_id, result, running, runError, runAllAnalyses])

  // ── Derived ─────────────────────────────────────────────────────────────────

  const injections = parseResult?.injections ?? []
  const selectedCal = calibrations.find(c => c.id === selectedCalId)

  // For blends, show only the active analyte's injections
  const displayInjections = (isBlend || hasMultipleAnalytes) && activeAnalyte
    ? injections.filter(inj => inj.peptide_label === activeAnalyte)
    : injections
  const activeInjData = displayInjections[activeInj]

  // For blends: filter chromatogram traces to the active analyte
  // Uses alias-aware matching: checks trace filename against the component's
  // abbreviation, name, and hplc_aliases (e.g. "BPC" in filename matches "BPC-157" component)
  const displayChromTraces = useMemo(() => {
    let sampleTraces: ChromatogramTrace[]
    if (!activeAnalyte || !hasMultipleAnalytes) {
      sampleTraces = chromTraces
    } else {
      // Build a set of tokens to match for the active analyte's component
      const comp = labelToComponent.get(activeAnalyte)
      const matchTokens: string[] = [activeAnalyte.toUpperCase()]
      if (comp) {
        // Add all known identifiers for this component (normalized, no dashes/spaces)
        const norm = (s: string) => s.toUpperCase().replace(/[-\s()]/g, '')
        matchTokens.push(norm(comp.abbreviation))
        matchTokens.push(norm(comp.name))
        if (comp.hplc_aliases) {
          for (const alias of comp.hplc_aliases) matchTokens.push(norm(alias))
        }
        // Also add raw abbreviation parts (e.g. "BPC" from "BPC-157")
        const abbrParts = comp.abbreviation.toUpperCase().split(/[-\s()]+/).filter(Boolean)
        for (const part of abbrParts) {
          if (part.length >= 3) matchTokens.push(part)
        }
      }

      const filtered = chromTraces.filter(t => {
        const n = t.name.toUpperCase()
        if (n.includes('BLANK') || n.includes('REQUIL')) return false
        // Check if any match token appears in the trace filename
        return matchTokens.some(token => n.includes(token))
      })

      sampleTraces = filtered.length > 0
        ? filtered
        : chromTraces.filter(t => {
            const n = t.name.toUpperCase()
            return !n.includes('BLANK') && !n.includes('REQUIL')
          })
    }

    // Prepend standard reference trace from the active calibration curve (if available)
    // Cast chromatogram_data to Record<string, unknown> because the runtime format
    // may be multi-concentration (keyed by conc level) even though the TS type
    // only declares the old single-trace shape.
    if (selectedCal?.chromatogram_data) {
      const stdTrace = extractStandardTrace(
        selectedCal.chromatogram_data as unknown as Record<string, unknown>,
      )
      if (stdTrace) {
        return [stdTrace, ...sampleTraces]
      }
    }

    return sampleTraces
  }, [chromTraces, activeAnalyte, hasMultipleAnalytes, selectedCal, labelToComponent])

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

  // ── Standard curve data extraction ─────────────────────────────────────────
  // For standard preps: map concentrations to injection peak areas/RTs.
  //
  // Primary path: vial_data has per-vial target concentrations. Sort vials by
  // target_conc ascending so they align with injections sorted numerically
  // (injection filenames contain the concentration, e.g. _Std_1000_PeakData).
  //
  // Fallback path: vial_data missing (prep saved before multi-vial support).
  // Extract concentration directly from each injection filename's numeric suffix.

  const standardCurveData = useMemo(() => {
    if (!isStandard || !parseResult) return null

    // Always sort injections numerically by name (lowest conc first)
    const sortedInjections = [...parseResult.injections].sort((a, b) =>
      a.injection_name.localeCompare(b.injection_name, undefined, { numeric: true })
    )

    const concentrations: number[] = []
    const areas: number[] = []
    const rts: number[] = []

    if (prep.vial_data && prep.vial_data.length > 0) {
      // Primary: sort vials by target_conc ascending to match injection order
      const sortedVials = [...prep.vial_data].sort(
        (a, b) => (a.target_conc_ug_ml ?? 0) - (b.target_conc_ug_ml ?? 0)
      )

      const count = Math.min(sortedVials.length, sortedInjections.length)
      for (let i = 0; i < count; i++) {
        const vial = sortedVials[i]
        const inj = sortedInjections[i]
        if (!vial || !inj) continue
        const conc = vial.target_conc_ug_ml
        if (conc == null || conc <= 0) continue
        const mainPeak = inj.main_peak_index >= 0 && inj.main_peak_index < inj.peaks.length
          ? inj.peaks[inj.main_peak_index]
          : null
        if (mainPeak) {
          concentrations.push(conc)
          areas.push(mainPeak.area)
          rts.push(mainPeak.retention_time)
        }
      }
    } else {
      // Fallback: extract concentration from injection filename
      // e.g. "P-0136_Std_1000_PeakData" → 1000
      for (const inj of sortedInjections) {
        const match = inj.injection_name.match(/_(\d+(?:\.\d+)?)_?PeakData/i)
          ?? inj.injection_name.match(/(\d+(?:\.\d+)?)(?:[^0-9]|$)/)
        const conc = match?.[1] != null ? parseFloat(match[1]) : null
        if (conc == null || conc <= 0) continue
        const mainPeak = inj.main_peak_index >= 0 && inj.main_peak_index < inj.peaks.length
          ? inj.peaks[inj.main_peak_index]
          : null
        if (mainPeak) {
          concentrations.push(conc)
          areas.push(mainPeak.area)
          rts.push(mainPeak.retention_time)
        }
      }
    }

    return concentrations.length > 0 ? { concentrations, areas, rts } : null
  }, [isStandard, parseResult, prep.vial_data])

  // Extract first valid chromatogram trace for standard curve provenance
  const standardChromData = useMemo(() => {
    if (!isStandard || chromTraces.length === 0) return undefined
    const first = chromTraces[0]
    if (!first || first.points.length === 0) return undefined
    return {
      times: first.points.map(p => p[0]),
      signals: first.points.map(p => p[1]),
    }
  }, [isStandard, chromTraces])

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
            {isStandard && (
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px] shrink-0',
                  standardCurveCreated
                    ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                    : 'border-amber-500/40 text-amber-600 dark:text-amber-400',
                )}
              >
                {standardCurveCreated ? 'Curve Created' : 'Standard'}
              </Badge>
            )}
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

        {/* Lab tech & instrument context */}
        <div className="mx-6 mt-4 rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">Tech:</span>
            <span className="font-medium truncate">{authUser?.email ?? '—'}</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <Cpu className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">Instrument:</span>
            <span className="font-medium truncate">{prep.instrument_name ?? '—'}</span>
          </div>
        </div>

        {/* Debug console overlay */}
        {showDebug && (
          <DebugConsole
            lines={
              buildDebugLines({
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
                parseError,
              })
            }
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

                {/* Re-run banner — shown when results were loaded from DB */}
                {savedResults && !running && (
                  <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-teal-500/30 bg-teal-500/5">
                    <div className="flex items-center gap-2 min-w-0">
                      <CheckCircle2 size={14} className="text-teal-500 shrink-0" />
                      <p className="text-xs text-teal-700 dark:text-teal-400 truncate">
                        Results loaded from previous run
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 h-7 text-xs border border-teal-500/30 hover:bg-teal-500/10 hover:text-teal-600"
                      onClick={() => {
                        // Clear all state so the SharePoint scan re-triggers
                        setSavedResults(null)
                        setResult(null)
                        setRunError(null)
                        setAnalyteResults(new Map())
                        setParseResult(null)
                        setChromTraces([])
                        setActiveAnalyte(null)
                        setActiveInj(0)
                        dbCheckActiveRef.current = false  // allow SharePoint scan
                        // loadPeakData will re-fire via useEffect since parseResult is now null
                        // and savedResults is null — both guards cleared
                      }}
                    >
                      Re-run Analysis
                    </Button>
                  </div>
                )}

                {/* Processing warnings banner — surface critical issues with action links */}
                {(() => {
                  const spUrl = match.folder_web_url ?? null
                  const warns: { msg: string; action?: React.ReactNode }[] = []

                  // Unmatched analytes — offer to add alias (only on fresh runs, not DB reload)
                  if (isBlend && !savedResults && parseResult?.detected_peptides) {
                    for (const label of parseResult.detected_peptides) {
                      if (!labelToComponent.has(label)) {
                        warns.push({
                          msg: `Analyte "${label}" could not be matched to a blend component — skipped`,
                          action: (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 text-xs font-medium text-amber-300 hover:text-amber-200 underline underline-offset-2"
                              onClick={async () => {
                                setAliasModalLabel(label)
                                setAliasModalPeptideId('')
                                setAliasModalSaving(false)
                                try {
                                  const peps = await getPeptides()
                                  setAliasModalPeptides(peps.filter(p => !p.is_blend))
                                } catch { /* non-critical */ }
                              }}
                            >
                              <Plus size={11} />
                              Add &quot;{label}&quot; as alias
                            </button>
                          ),
                        })
                      }
                    }
                  }

                  // Missing standard injections (fresh runs only)
                  if (isBlend && !savedResults && parseResult && labelToComponent.size > 0) {
                    const stdLabels = new Set(parseResult.standard_injections?.map(si => si.analyte_label) ?? [])
                    if (stdLabels.size === 0 && labelToComponent.size > 0) {
                      warns.push({
                        msg: 'No standard injection files found — identity uses calibration curve RT (may be from a different method)',
                        action: spUrl ? (
                          <a href={spUrl} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-medium text-amber-300 hover:text-amber-200 underline underline-offset-2">
                            <ExternalLink size={11} />
                            Open SharePoint folder
                          </a>
                        ) : undefined,
                      })
                    } else {
                      for (const [label, comp] of labelToComponent.entries()) {
                        if (!stdLabels.has(label)) {
                          warns.push({
                            msg: `No standard injection for ${comp.abbreviation} — identity uses calibration curve RT`,
                            action: spUrl ? (
                              <a href={spUrl} target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-medium text-amber-300 hover:text-amber-200 underline underline-offset-2">
                                <ExternalLink size={11} />
                                Open folder
                              </a>
                            ) : undefined,
                          })
                        }
                      }
                    }
                  }

                  // Missing vial data
                  if (isBlend && (!prep.vial_data || prep.vial_data.length === 0) && blendComponents.some(c => (c.vial_number ?? 1) > 1)) {
                    warns.push({ msg: 'No per-vial weight data — using same weights for all analytes (quantities may be incorrect)' })
                  }

                  // Identity fallbacks
                  if (result && analyteResults.size > 0) {
                    for (const [, r] of analyteResults.entries()) {
                      if (r.identity_reference_source === 'calibration_curve' && r.identity_conforms === false) {
                        warns.push({
                          msg: `${r.peptide_abbreviation} identity DOES NOT CONFORM — reference RT from calibration curve (different method?)`,
                          action: spUrl ? (
                            <a href={spUrl} target="_blank" rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs font-medium text-amber-300 hover:text-amber-200 underline underline-offset-2">
                              <ExternalLink size={11} />
                              Check std injections in folder
                            </a>
                          ) : undefined,
                        })
                      }
                    }
                  }

                  // Parser-level warnings (e.g. file contains wrong sample data)
                  if (parseResult?.warnings?.length) {
                    for (const w of parseResult.warnings) {
                      warns.push({
                        msg: w,
                        action: spUrl ? (
                          <a href={spUrl} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-medium text-red-300 hover:text-red-200 underline underline-offset-2">
                            <ExternalLink size={11} />
                            Check files in folder
                          </a>
                        ) : undefined,
                      })
                    }
                  }

                  if (warns.length === 0) return null

                  return (
                    <div className="px-4 py-3 rounded-lg border border-amber-500/30 bg-amber-500/5 space-y-2">
                      <div className="flex items-center gap-2">
                        <AlertTriangle size={14} className="text-amber-500 shrink-0" />
                        <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                          {warns.length} warning{warns.length !== 1 ? 's' : ''}
                        </p>
                      </div>
                      {warns.map((w, i) => (
                        <div key={i} className="flex items-start justify-between gap-3 pl-5">
                          <p className="text-xs text-amber-600 dark:text-amber-400/80">{w.msg}</p>
                          {w.action && <div className="shrink-0">{w.action}</div>}
                        </div>
                      ))}
                    </div>
                  )
                })()}

                {/* Analysis results */}
                {running && (
                  <div className="flex flex-col items-center gap-3 py-8">
                    <Spinner className="size-6" />
                    <p className="text-sm text-muted-foreground">
                      Running analysis{hasMultipleAnalytes ? ` (${blendPeptides.length} analytes)` : ''}…
                    </p>
                  </div>
                )}
                {!isStandard && result && (
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
                    {/* ── Standard curve review (replaces weights + calibration for standards) ── */}
                    {isStandard && !standardCurveData && (
                      <div className="flex items-start gap-3 p-4 rounded-lg border border-amber-500/30 bg-amber-500/5">
                        <AlertTriangle size={16} className="text-amber-500 mt-0.5 shrink-0" />
                        <div className="space-y-1 text-sm">
                          <p className="font-medium text-amber-700 dark:text-amber-400">Could not extract concentration data</p>
                          <p className="text-muted-foreground text-xs">
                            No concentration values found in injection filenames or no main peaks identified.
                            Expected filenames like <code className="font-mono bg-muted px-1 rounded">_1000_PeakData.csv</code>.
                            Open the debug console (terminal icon) to see what was parsed.
                          </p>
                        </div>
                      </div>
                    )}
                    {isStandard && standardCurveData && (
                      <StandardCurveReview
                        peptideId={prep.peptide_id}
                        samplePrepId={prep.senaite_sample_id ?? prep.sample_id}
                        concentrations={standardCurveData.concentrations}
                        areas={standardCurveData.areas}
                        rts={standardCurveData.rts}
                        chromatogramData={standardChromData}
                        sharepointFolder={match.folder_name}
                        vendor={prep.manufacturer ?? undefined}
                        notes={prep.standard_notes ?? undefined}
                        instrument={prep.instrument_name ?? undefined}
                        onCurveCreated={() => {
                          setStandardCurveCreated(true)
                          updateSamplePrep(prep.id, { status: 'curve_created' }).catch(_e => { /* non-blocking */ })
                          prep.status = 'curve_created'
                        }}
                      />
                    )}

                    {/* ── Normal (non-standard) flow: weights + calibration ── */}
                    {!isStandard && (
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
                    </>
                    )}

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
              {!isStandard && result?.calculation_trace && (
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

            {/* Submit Results button — not applicable for standards */}
            {!isStandard && result && (
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
            onComplete={() => { prep.status = 'hplc_complete' }}
          />
        ) : null}
      </SheetContent>

      {/* Add Alias modal */}
      <Dialog open={aliasModalLabel !== null} onOpenChange={v => { if (!v) setAliasModalLabel(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add File Alias</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Add <span className="font-mono font-medium text-foreground">{aliasModalLabel}</span> as
              an HPLC file alias so it matches during blend processing.
            </p>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Select peptide</label>
              <Select value={aliasModalPeptideId} onValueChange={setAliasModalPeptideId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a peptide..." />
                </SelectTrigger>
                <SelectContent>
                  {aliasModalPeptides.map(p => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.abbreviation}
                      {p.hplc_aliases?.length ? (
                        <span className="text-muted-foreground ml-2">
                          ({p.hplc_aliases.join(', ')})
                        </span>
                      ) : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAliasModalLabel(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!aliasModalPeptideId || aliasModalSaving}
                onClick={async () => {
                  if (!aliasModalPeptideId || !aliasModalLabel) return
                  setAliasModalSaving(true)
                  try {
                    const pep = aliasModalPeptides.find(p => String(p.id) === aliasModalPeptideId)
                    const existing = pep?.hplc_aliases ?? []
                    if (!existing.includes(aliasModalLabel)) {
                      await updatePeptide(parseInt(aliasModalPeptideId, 10), {
                        hplc_aliases: [...existing, aliasModalLabel],
                      })
                    }
                    setAliasModalLabel(null)
                  } catch (e) {
                    console.error('Failed to add alias:', e)
                  } finally {
                    setAliasModalSaving(false)
                  }
                }}
              >
                {aliasModalSaving ? <Spinner className="size-3 mr-1" /> : <Plus size={14} className="mr-1" />}
                Add Alias
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Sheet>
  )
}
