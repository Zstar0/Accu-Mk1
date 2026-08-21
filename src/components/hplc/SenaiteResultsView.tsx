/**
 * SenaiteResultsView
 *
 * Second view in the HPLC flyout — loads a Senaite sample and renders
 * the AnalysisTable so the user can submit/verify results directly.
 * Includes auto-fill to push HPLC analysis values into matching Senaite rows.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { ArrowLeft, FlaskConical, AlertTriangle, Zap, Check, X, Loader2, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import {
  lookupSenaiteSample,
  setAnalysisResult,
  transitionAnalysis,
  updateSamplePrep,
  uploadChromatogramToSenaite,
  renderChromatogramImage,
  refetchChromatogram,
  type SamplePrep,
  type HPLCAnalysisResult,
  type SenaiteLookupResult,
  type SenaiteAnalysis,
} from '@/lib/api'
import { AnalysisTable, StatusBadge } from '@/components/senaite/AnalysisTable'

// ── Auto-fill mapping ─────────────────────────────────────────────────────────

/** States where we can write a result value. */
const FILLABLE_STATES = new Set<string | null>(['unassigned', 'assigned', null])

/** Round to 2 decimals — the precision written to AR result fields.
 *  Blend totals must be the sum of the ROUNDED per-analyte values (lab
 *  ruling 2026-08-20): round each item first, then add — so the total on
 *  the AR always equals the sum of the per-analyte results it sits next
 *  to. Summing full-precision values and rounding once can differ in the
 *  last decimal. */
export const round2 = (n: number) => Math.round(n * 100) / 100

interface AutoFillMapping {
  analysis: SenaiteAnalysis
  value: string
  label: string
  type: 'purity' | 'quantity' | 'identity'
  /** Why this row can't be plain-filled right now. `submitted` rows are
   *  recoverable via retract-and-refill (SENAITE hard-locks the Result
   *  field at to_be_verified — proven live 2026-08-20, both per-user and
   *  service accounts get "Not allowed to set the field 'Result'").
   *  `verified` rows need the retest verb (retract is silently rejected
   *  there) — surfaced but not actionable in v1. Absent = fillable. */
  lock?: 'submitted' | 'verified'
}

/** Classify a review_state for auto-fill: fillable now (undefined),
 *  recoverable via retract ('submitted'), needs retest ('verified'),
 *  or never a fill target ('skip' — retracted/rejected/cancelled rows
 *  must not match, the fresh post-retract copy matches instead). */
function lockForState(
  state: string | null
): 'submitted' | 'verified' | 'skip' | undefined {
  if (FILLABLE_STATES.has(state)) return undefined
  if (state === 'to_be_verified') return 'submitted'
  if (state === 'verified' || state === 'published') return 'verified'
  return 'skip'
}

/**
 * Check if a Senaite analysis title/keyword is relevant to the given peptide.
 *
 * Handles multiple naming conventions:
 *  - Generic:    "Peptide Purity (HPLC)", "Peptide Total Quantity"
 *  - Per-analyte: "KPV Purity", "GHK-Cu Quantity"
 *  - Dashed:     "BPC-157 - Identity (HPLC)"
 */
function isRelevantAnalysis(name: string, peptide: string): boolean {
  return name.includes(peptide) || name.startsWith('peptide ')
}

/**
 * Resolve "Analyte N ..." titles to peptide names using the name map.
 */
function resolveAnalysisName(title: string, nameMap: Map<number, string>): string {
  const match = title.match(/^Analyte\s+(\d)\s*(.*)/i)
  if (match?.[1]) {
    const slot = parseInt(match[1], 10)
    const suffix = match[2] ?? ''
    const peptideName = nameMap.get(slot)
    if (peptideName) return `${peptideName} ${suffix}`.trim().toLowerCase()
  }
  return title.toLowerCase()
}

/**
 * Build a list of Senaite analyses that can be auto-filled from a single HPLC result.
 */
function buildAutoFillMappings(
  result: HPLCAnalysisResult,
  analyses: SenaiteAnalysis[],
  nameMap: Map<number, string>,
): AutoFillMapping[] {
  const peptide = result.peptide_abbreviation?.toLowerCase()
  if (!peptide) return []

  const mappings: AutoFillMapping[] = []

  for (const a of analyses) {
    if (!a.uid) continue
    const lock = lockForState(a.review_state)
    if (lock === 'skip') continue

    const name = resolveAnalysisName(a.title ?? a.keyword ?? '', nameMap)
    if (!isRelevantAnalysis(name, peptide)) continue

    // Skip blend-level aggregates — handled in buildAllAutoFillMappings
    if (name.includes('blend purity') || (name.includes('total') && name.includes('quantity'))) continue
    if (name === 'peptide id (hplc)' || (name.startsWith('peptide') && name.includes('id') && name.includes('hplc'))) continue

    if (name.includes('purity') && result.purity_percent != null) {
      mappings.push({
        analysis: a,
        value: result.purity_percent.toFixed(2),
        label: `${result.purity_percent.toFixed(2)}%`,
        type: 'purity',
        ...(lock ? { lock } : {}),
      })
    } else if (name.includes('quantity') && result.quantity_mg != null) {
      mappings.push({
        analysis: a,
        value: result.quantity_mg.toFixed(2),
        label: `${result.quantity_mg.toFixed(2)} mg`,
        type: 'quantity',
        ...(lock ? { lock } : {}),
      })
    } else if (name.includes('identity') && result.identity_conforms != null) {
      // Try to match against predefined result_options
      const opts = a.result_options ?? []
      let value: string
      if (opts.length > 0) {
        const target = result.identity_conforms ? 'conform' : 'not conform'
        const altTarget = result.identity_conforms ? 'pass' : 'fail'
        const match = opts.find(o => {
          const v = o.value.toLowerCase()
          return v.includes(target) || v.includes(altTarget)
        })
        value = match?.value ?? (result.identity_conforms ? '1' : '0')
      } else {
        value = result.identity_conforms ? 'Conforms' : 'Does Not Conform'
      }
      mappings.push({
        analysis: a,
        value,
        label: result.identity_conforms ? 'Conforms' : 'Does Not Conform',
        type: 'identity',
        ...(lock ? { lock } : {}),
      })
    }
  }

  return mappings
}

/**
 * Aggregate auto-fill mappings from multiple HPLC results (blend support).
 * Per-analyte matches (e.g. "KPV Purity") are claimed first; generic matches
 * (e.g. "Peptide Purity") only fill if unclaimed.
 * Also fills blend-level aggregates: Blend Purity, Peptide Total Quantity,
 * Peptide ID (HPLC).
 */
// Exported for tests (senaite-autofill-qty.test.ts) — not part of the
// component API.
export function buildAllAutoFillMappings(
  results: HPLCAnalysisResult[],
  analyses: SenaiteAnalysis[],
  nameMap: Map<number, string>,
): AutoFillMapping[] {
  const allMappings: AutoFillMapping[] = []
  const claimed = new Set<string>()

  for (const result of results) {
    const mappings = buildAutoFillMappings(result, analyses, nameMap)
    for (const m of mappings) {
      const uid = m.analysis.uid ?? ''
      if (!claimed.has(uid)) {
        claimed.add(uid)
        allMappings.push(m)
      }
    }
  }

  // Aggregate analyses: Peptide Total Quantity, Blend Purity, Peptide ID (HPLC)
  {
    // Round-then-sum (see round2) so the total matches the per-analyte fields.
    const totalQty = results.reduce((sum, r) => sum + round2(r.quantity_mg ?? 0), 0)
    const weightedPuritySum = results.reduce(
      (sum, r) => sum + (r.quantity_mg ?? 0) * (r.purity_percent ?? 0), 0
    )
    const blendPurity = totalQty > 0 ? weightedPuritySum / totalQty : 0
    const blendIdentity = results.every(r => r.identity_conforms === true)

    for (const a of analyses) {
      if (!a.uid || claimed.has(a.uid)) continue
      const lock = lockForState(a.review_state)
      if (lock === 'skip') continue
      const name = (a.title ?? a.keyword ?? '').toLowerCase()

      if (name.includes('blend purity') && blendPurity > 0) {
        claimed.add(a.uid)
        allMappings.push({
          analysis: a,
          value: blendPurity.toFixed(2),
          label: `${blendPurity.toFixed(2)}%`,
          type: 'purity',
          ...(lock ? { lock } : {}),
        })
      } else if (name.includes('total') && name.includes('quantity') && totalQty > 0) {
        claimed.add(a.uid)
        allMappings.push({
          analysis: a,
          value: totalQty.toFixed(2),
          label: `${totalQty.toFixed(2)} mg`,
          type: 'quantity',
          ...(lock ? { lock } : {}),
        })
      } else if (name === 'peptide id (hplc)' || (name.startsWith('peptide') && name.includes('id') && name.includes('hplc'))) {
        // Blend-level identity (Peptide ID) — conforms only if all analytes conform
        const opts = a.result_options ?? []
        let value: string
        if (opts.length > 0) {
          const target = blendIdentity ? 'conform' : 'not conform'
          const altTarget = blendIdentity ? 'pass' : 'fail'
          const match = opts.find(o => {
            const v = o.value.toLowerCase()
            return v.includes(target) || v.includes(altTarget)
          })
          value = match?.value ?? (blendIdentity ? '1' : '0')
        } else {
          value = blendIdentity ? 'Conforms' : 'Does Not Conform'
        }
        claimed.add(a.uid)
        allMappings.push({
          analysis: a,
          value,
          label: blendIdentity ? 'Conforms' : 'Does Not Conform',
          type: 'identity',
          ...(lock ? { lock } : {}),
        })
      }
    }
  }

  return allMappings
}

// ── Retract & refill orchestration ───────────────────────────────────────────

export interface RetractRefillDeps {
  /** transitionAnalysis(uid, 'retract') — the proxy post-verifies the state
   *  flip and reports SENAITE's silent rejections as success:false. */
  retract: (uid: string) => Promise<{ success: boolean; message?: string }>
  refill: (uid: string, value: string) => Promise<{ success: boolean; message?: string }>
  relookup: () => Promise<SenaiteLookupResult>
}

/**
 * Second-run recovery for submitted results: retract each locked row (the
 * old value stays in the AR history as `retracted`), re-look-up to find the
 * fresh copy SENAITE minted (same keyword, fillable state, new uid — note
 * the copy is born carrying the OLD value, which is exactly the hand-typing
 * trap this replaces), then fill it with the run-2 value.
 *
 * Returns per-row status keyed by the ORIGINAL uid (the UI lists rows by
 * the mapping's analysis uid). Exported for tests.
 */
export async function runRetractRefill(
  mappings: AutoFillMapping[],
  deps: RetractRefillDeps,
): Promise<Map<string, 'success' | 'error'>> {
  const results = new Map<string, 'success' | 'error'>()
  const retracted: AutoFillMapping[] = []

  for (const m of mappings) {
    const uid = m.analysis.uid
    if (!uid) continue
    try {
      const resp = await deps.retract(uid)
      if (resp.success) retracted.push(m)
      else results.set(uid, 'error')
    } catch {
      results.set(uid, 'error')
    }
  }

  if (retracted.length === 0) return results

  let fresh: SenaiteLookupResult
  try {
    fresh = await deps.relookup()
  } catch {
    // Retracts landed but we can't find the copies — mark them errored so
    // the tech knows to finish in the table below.
    for (const m of retracted) results.set(m.analysis.uid ?? '', 'error')
    return results
  }

  const consumed = new Set<string>()
  for (const m of retracted) {
    const oldUid = m.analysis.uid ?? ''
    const copy = (fresh.analyses ?? []).find(
      a =>
        a.uid &&
        a.uid !== oldUid &&
        !consumed.has(a.uid) &&
        FILLABLE_STATES.has(a.review_state) &&
        (m.analysis.keyword != null
          ? a.keyword === m.analysis.keyword
          : a.title === m.analysis.title)
    )
    if (!copy?.uid) {
      results.set(oldUid, 'error')
      continue
    }
    consumed.add(copy.uid)
    try {
      const resp = await deps.refill(copy.uid, m.value)
      results.set(oldUid, resp.success ? 'success' : 'error')
    } catch {
      results.set(oldUid, 'error')
    }
  }

  return results
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  prep: SamplePrep
  results: HPLCAnalysisResult[]
  onBack: () => void
  onComplete?: () => void
}

export function SenaiteResultsView({ prep, results: hplcResults, onBack, onComplete }: Props) {
  const [sampleIdInput, setSampleIdInput] = useState(
    prep.senaite_sample_id ?? '',
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [senaiteData, setSenaiteData] = useState<SenaiteLookupResult | null>(null)

  // Auto-fill state
  const [filling, setFilling] = useState(false)
  const [fillResults, setFillResults] = useState<Map<string, 'success' | 'error'>>(new Map())

  // Retract-and-refill state (second-run recovery for submitted rows)
  const [retracting, setRetracting] = useState(false)
  const [confirmRetract, setConfirmRetract] = useState(false)
  const [retractResults, setRetractResults] = useState<Map<string, 'success' | 'error'>>(new Map())

  // Chromatogram preview
  const [chromUrl, setChromUrl] = useState<string | null>(null)
  const [chromLoading, setChromLoading] = useState(false)
  const [refetching, setRefetching] = useState(false)

  // Render chromatogram image on mount (from first result with chromatogram data)
  const chromAnalysisId = hplcResults.find(r => r.chromatogram_data?.times?.length)?.id ?? null

  useEffect(() => {
    if (!chromAnalysisId || chromUrl) return
    let cancelled = false
    setChromLoading(true)
    renderChromatogramImage(chromAnalysisId)
      .then(url => { if (!cancelled) setChromUrl(url) })
      .catch(e => console.warn('[Chromatogram] render failed:', e))
      .finally(() => { if (!cancelled) setChromLoading(false) })
    return () => { cancelled = true }
  }, [chromAnalysisId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLoad = useCallback(async () => {
    const id = sampleIdInput.trim()
    if (!id) return
    setLoading(true)
    setError(null)
    setFillResults(new Map())
    try {
      const data = await lookupSenaiteSample(id)
      setSenaiteData(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sample')
      setSenaiteData(null)
    } finally {
      setLoading(false)
    }
  }, [sampleIdInput])

  // Auto-load on mount if prep has a Senaite sample ID
  const didAutoLoad = useRef(false)
  useEffect(() => {
    if (!didAutoLoad.current && prep.senaite_sample_id) {
      didAutoLoad.current = true
      handleLoad()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Build analyteNameMap from loaded data. Prefer the matched peptide's
  // ABBREVIATION: HPLC results key analytes by abbreviation, and when it
  // diverges from the peptide name (e.g. TB500 (Thymosin Beta 4) vs
  // Thymosin Beta-4) name-based slot matching fails silently — the blend's
  // per-analyte QTY/purity fields then never auto-fill.
  const analyteNameMap = new Map<number, string>()
  if (senaiteData) {
    for (const analyte of senaiteData.analytes) {
      const displayName =
        analyte.matched_peptide_abbreviation ??
        analyte.matched_peptide_name ??
        analyte.raw_name.replace(/\s*-\s*[^-]+\([^)]+\)\s*$/, '')
      analyteNameMap.set(analyte.slot_number, displayName)
    }
  }

  // Derived counts
  const analyses = senaiteData?.analyses ?? []
  const verifiedCount = analyses.filter(
    a => a.review_state === 'verified' || a.review_state === 'published',
  ).length
  const pendingCount = analyses.length - verifiedCount

  // Auto-fill mappings
  const autoFillMappings = senaiteData ? buildAllAutoFillMappings(hplcResults, analyses, analyteNameMap) : []
  // Partition: plain-fillable now / submitted (retract-and-refill, SENAITE
  // rows only — native mk1: rows keep their transitions in the table below) /
  // verified (needs the retest verb; not actionable in v1).
  const fillableMappings = autoFillMappings.filter(m => !m.lock)
  const submittedMappings = autoFillMappings.filter(
    m => m.lock === 'submitted' && m.analysis.uid && !m.analysis.uid.startsWith('mk1:')
  )
  const nativeSubmittedCount = autoFillMappings.filter(
    m => m.lock === 'submitted' && m.analysis.uid?.startsWith('mk1:')
  ).length
  const verifiedLockedCount = autoFillMappings.filter(m => m.lock === 'verified').length

  // "Analyte N ..." titles render with the resolved peptide name.
  const displayTitle = (m: AutoFillMapping) => {
    const match = m.analysis.title.match(/^Analyte\s+(\d)\s*(.*)/i)
    if (match?.[1]) {
      const slot = parseInt(match[1], 10)
      const suffix = match[2] ?? ''
      const name = analyteNameMap.get(slot)
      if (name) return `${name} ${suffix}`.trim()
    }
    return m.analysis.title
  }

  // ── Auto-fill handler ───────────────────────────────────────────────────────

  const handleAutoFill = useCallback(async () => {
    if (fillableMappings.length === 0) return
    setFilling(true)
    const results = new Map<string, 'success' | 'error'>()

    for (const mapping of fillableMappings) {
      const uid = mapping.analysis.uid
      if (!uid) continue
      try {
        const resp = await setAnalysisResult(uid, mapping.value)
        if (resp.success) {
          results.set(uid, 'success')
          // Optimistic update
          setSenaiteData(prev => {
            if (!prev) return prev
            return {
              ...prev,
              analyses: prev.analyses.map(a =>
                a.uid === uid
                  ? { ...a, result: mapping.value, review_state: resp.new_review_state ?? a.review_state }
                  : a,
              ),
            }
          })
        } else {
          results.set(uid, 'error')
        }
      } catch {
        results.set(uid, 'error')
      }
    }

    setFillResults(results)
    setFilling(false)

    const successCount = [...results.values()].filter(v => v === 'success').length
    const errorCount = [...results.values()].filter(v => v === 'error').length
    if (errorCount === 0) {
      toast.success(`Filled ${successCount} result${successCount !== 1 ? 's' : ''} successfully`)
    } else {
      toast.warning(`${successCount} filled, ${errorCount} failed`)
    }

    // Upload chromatogram image to SENAITE (best-effort, non-blocking)
    if (successCount > 0 && senaiteData?.sample_uid) {
      const firstHplcResult = hplcResults[0]
      if (firstHplcResult?.id) {
        uploadChromatogramToSenaite(firstHplcResult.id, senaiteData.sample_uid)
          .then(r => { if (r.success) toast.success('Chromatogram CSV uploaded to SENAITE') })
          .catch(() => { /* best-effort — don't block the user */ })
      }
    }
  }, [fillableMappings, senaiteData, hplcResults])

  const handleRetractRefill = useCallback(async () => {
    if (submittedMappings.length === 0) return
    setRetracting(true)
    setConfirmRetract(false)
    try {
      const results = await runRetractRefill(submittedMappings, {
        retract: uid => transitionAnalysis(uid, 'retract'),
        refill: (uid, value) => setAnalysisResult(uid, value),
        relookup: () => lookupSenaiteSample(sampleIdInput.trim() || prep.senaite_sample_id || ''),
      })
      setRetractResults(results)
      const ok = [...results.values()].filter(v => v === 'success').length
      const bad = [...results.values()].filter(v => v === 'error').length
      if (bad === 0) {
        toast.success(
          `Retracted & refilled ${ok} result${ok !== 1 ? 's' : ''} — review and submit below`
        )
      } else {
        toast.warning(`${ok} refilled, ${bad} failed — finish the failed rows in the table below`)
      }
      // Refresh so the table and mappings reflect the fresh copies.
      try {
        const data = await lookupSenaiteSample(sampleIdInput.trim() || prep.senaite_sample_id || '')
        setSenaiteData(data)
      } catch {
        /* stale view is recoverable with the Load button */
      }
    } finally {
      setRetracting(false)
    }
  }, [submittedMappings, sampleIdInput, prep.senaite_sample_id])

  // ── AnalysisTable callbacks ──────────────────────────────────────────────────

  const handleResultSaved = useCallback(
    (uid: string, newResult: string, newReviewState: string | null) => {
      setSenaiteData(prev => {
        if (!prev) return prev
        return {
          ...prev,
          analyses: prev.analyses.map(a =>
            a.uid === uid
              ? { ...a, result: newResult, review_state: newReviewState ?? a.review_state }
              : a,
          ),
        }
      })
    },
    [],
  )

  const handleTransitionComplete = useCallback(() => {
    handleLoad()
  }, [handleLoad])

  const handleMethodInstrumentSaved = useCallback(
    (uid: string, field: 'method' | 'instrument', newUid: string | null, newTitle: string | null) => {
      setSenaiteData(prev => {
        if (!prev) return prev
        return {
          ...prev,
          analyses: prev.analyses.map(a => {
            if (a.uid !== uid) return a
            if (field === 'method') {
              return { ...a, method_uid: newUid, method: newTitle }
            }
            return { ...a, instrument_uid: newUid, instrument: newTitle }
          }),
        }
      })
    },
    [],
  )

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col">
      {/* Back button + sample ID input */}
      <div className="px-6 pt-5 pb-4 border-b border-border/60 space-y-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="gap-1.5 text-muted-foreground hover:text-foreground -ml-2"
        >
          <ArrowLeft size={15} />
          Back to Analysis
        </Button>

        <div className="flex items-center gap-2">
          <Input
            value={sampleIdInput}
            onChange={e => setSampleIdInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLoad()}
            placeholder="Senaite Sample ID (e.g. PB-0063)"
            className="font-mono text-sm h-8 flex-1"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={handleLoad}
            disabled={loading || !sampleIdInput.trim()}
            className="h-8 gap-1.5 shrink-0"
          >
            {loading && <Spinner className="size-3" />}
            Load
          </Button>
        </div>
      </div>

      {/* HPLC Results Summary */}
      {hplcResults.length > 0 && (
        <div className="px-6 pt-5 pb-4 border-b border-border/60">
          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">HPLC Results Summary</h3>
              <span className="text-xs text-muted-foreground">
                {hplcResults.length} analyte{hplcResults.length !== 1 ? 's' : ''}
              </span>
            </div>

            <div className="rounded-md border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 border-b border-border">
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Analyte</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground">Purity</th>
                    <th className="text-right px-3 py-2 font-medium text-muted-foreground">Quantity</th>
                    <th className="text-center px-3 py-2 font-medium text-muted-foreground">Identity</th>
                  </tr>
                </thead>
                <tbody>
                  {hplcResults.map((r, i) => (
                    <tr key={i} className="border-b border-border/50 last:border-0">
                      <td className="px-3 py-2 font-medium">
                        {r.peptide_abbreviation ?? `Analyte ${i + 1}`}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {r.purity_percent != null ? `${r.purity_percent.toFixed(2)}%` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {r.quantity_mg != null ? `${r.quantity_mg.toFixed(2)} mg` : '—'}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {r.identity_conforms === true ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 size={12} />
                            Conforms
                          </span>
                        ) : r.identity_conforms === false ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
                            <AlertTriangle size={12} />
                            Does Not Conform
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {hplcResults.length > 1 && (() => {
              const totalQty = hplcResults.reduce((sum, r) => sum + round2(r.quantity_mg ?? 0), 0)
              const weightedPuritySum = hplcResults.reduce(
                (sum, r) => sum + (r.quantity_mg ?? 0) * (r.purity_percent ?? 0), 0
              )
              const blendPurity = totalQty > 0 ? weightedPuritySum / totalQty : 0
              const blendIdentity = hplcResults.every(r => r.identity_conforms === true)

              return (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/30 border border-border/50">
                    <span className="text-sm font-medium">Blend Purity</span>
                    <span className="text-sm font-mono font-semibold">{blendPurity.toFixed(2)}%</span>
                  </div>
                  <div className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/30 border border-border/50">
                    <span className="text-sm font-medium">Peptide Total Quantity</span>
                    <span className="text-sm font-mono font-semibold">{totalQty.toFixed(2)} mg</span>
                  </div>
                  <div className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/30 border border-border/50">
                    <span className="text-sm font-medium">Blend Identity</span>
                    {blendIdentity ? (
                      <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 size={14} />
                        Conforms
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-sm font-medium text-destructive">
                        <AlertTriangle size={14} />
                        Does Not Conform
                      </span>
                    )}
                  </div>
                </div>
              )
            })()}
          </div>
        </div>
      )}

      {/* Chromatogram Preview */}
      {hplcResults.length > 0 && (
        <div className="px-6 pt-4 pb-4 border-b border-border/60">
          <div className="rounded-lg border border-border bg-card p-4 space-y-2">
            <h3 className="text-sm font-semibold">Chromatogram</h3>
            {chromLoading || refetching ? (
              <div className="flex items-center justify-center py-8">
                <Spinner className="size-5" />
                <span className="ml-2 text-sm text-muted-foreground">
                  {refetching ? 'Fetching chromatogram from SharePoint...' : 'Rendering chromatogram...'}
                </span>
              </div>
            ) : chromUrl ? (
              <>
                <img
                  src={chromUrl}
                  alt="HPLC Chromatogram"
                  className="w-full rounded border border-border/50"
                />
                <p className="text-xs text-muted-foreground">
                  The chromatogram data will be uploaded as a CSV to SENAITE when you auto-fill results.
                </p>
              </>
            ) : (
              <div className="flex flex-col items-center gap-3 py-6">
                <p className="text-sm text-muted-foreground">No chromatogram data stored for this analysis.</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={async () => {
                    const firstResult = hplcResults[0]
                    if (!firstResult?.id) return
                    setRefetching(true)
                    try {
                      await refetchChromatogram(firstResult.id)
                      // Now render the image
                      const url = await renderChromatogramImage(firstResult.id)
                      setChromUrl(url)
                      toast.success('Chromatogram fetched from SharePoint')
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : 'Failed to fetch chromatogram')
                    } finally {
                      setRefetching(false)
                    }
                  }}
                >
                  Fetch Chromatogram
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mx-6 mt-4 flex items-start gap-3 p-4 rounded-lg border border-destructive/30 bg-destructive/5">
          <AlertTriangle size={16} className="text-destructive mt-0.5 shrink-0" />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Loading spinner (initial load only) */}
      {loading && !senaiteData && (
        <div className="flex flex-col items-center gap-3 py-12">
          <Spinner className="size-6" />
          <p className="text-sm text-muted-foreground">Loading Senaite sample…</p>
        </div>
      )}

      {/* Sample header + Auto-fill + AnalysisTable */}
      {senaiteData && (
        <div className="px-6 py-5 space-y-5">
          {/* Sample header */}
          <div className="flex items-start justify-between gap-x-4 gap-y-2 flex-wrap pb-4 border-b border-border/40">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-violet-600/20 to-violet-500/5 border border-violet-500/30 dark:border-violet-500/20">
                <FlaskConical size={18} className="text-violet-600 dark:text-violet-400" />
              </div>
              <div>
                <div className="flex items-center gap-3 flex-wrap">
                  <h2 className="text-lg font-bold tracking-tight font-mono">
                    {senaiteData.sample_id}
                  </h2>
                  {senaiteData.review_state && (
                    <StatusBadge state={senaiteData.review_state} />
                  )}
                  {senaiteData.sample_type && (
                    <Badge
                      variant="outline"
                      className="bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-400 dark:border-violet-500/20"
                    >
                      {senaiteData.sample_type}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {senaiteData.client ?? '—'}
                </p>
              </div>
            </div>

            {analyses.length > 0 && (
              <div className="flex items-center gap-5 text-center">
                <div>
                  <div className="text-base font-bold text-emerald-700 dark:text-emerald-400">
                    {verifiedCount}
                  </div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    Verified
                  </div>
                </div>
                <div className="w-px h-7 bg-border" />
                <div>
                  <div className="text-base font-bold text-amber-600 dark:text-amber-400">
                    {pendingCount}
                  </div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    Pending
                  </div>
                </div>
                <div className="w-px h-7 bg-border" />
                <div>
                  <div className="text-base font-bold text-foreground">
                    {analyses.length}
                  </div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    Total
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Auto-fill card */}
          {(fillableMappings.length > 0 ||
            submittedMappings.length > 0 ||
            verifiedLockedCount > 0 ||
            nativeSubmittedCount > 0) && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-500/20 bg-amber-50/50 dark:bg-amber-500/5 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Zap size={15} className="text-amber-600 dark:text-amber-400" />
                  <span className="text-sm font-medium">
                    Auto-fill from {hplcResults.length === 1
                      ? `${hplcResults[0]?.peptide_abbreviation} analysis`
                      : `${hplcResults.length} analyte analyses`}
                  </span>
                </div>
                {fillableMappings.length > 0 && (
                  <Button
                    size="sm"
                    onClick={handleAutoFill}
                    disabled={filling || fillResults.size > 0}
                    className="h-7 gap-1.5 text-xs"
                  >
                    {filling ? (
                      <>
                        <Loader2 size={13} className="animate-spin" />
                        Filling…
                      </>
                    ) : fillResults.size > 0 ? (
                      <>
                        <Check size={13} />
                        Filled
                      </>
                    ) : (
                      <>
                        <Zap size={13} />
                        Fill {fillableMappings.length} result{fillableMappings.length !== 1 ? 's' : ''}
                      </>
                    )}
                  </Button>
                )}
              </div>

              {fillableMappings.length > 0 && (
                <div className="grid gap-1.5">
                  {fillableMappings.map(m => {
                    const uid = m.analysis.uid ?? ''
                    const status = fillResults.get(uid)
                    return (
                      <div
                        key={uid}
                        className="flex items-center gap-2 text-xs"
                      >
                        {status === 'success' ? (
                          <Check size={12} className="text-emerald-600 shrink-0" />
                        ) : status === 'error' ? (
                          <X size={12} className="text-destructive shrink-0" />
                        ) : (
                          <div className="w-3 h-3 rounded-full border border-border shrink-0" />
                        )}
                        <span className="text-muted-foreground">{displayTitle(m)}</span>
                        <span className="text-foreground font-mono font-medium">{m.label}</span>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Submitted rows from a previous run: SENAITE locks the Result
                  field once submitted; the sanctioned unlock is retract (the
                  run-1 value stays in the AR history), then filling the fresh
                  copy SENAITE mints. Confirm-gated. */}
              {submittedMappings.length > 0 && (
                <div className="space-y-2 border-t border-amber-200/60 dark:border-amber-500/15 pt-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-muted-foreground">
                      {submittedMappings.length} result{submittedMappings.length !== 1 ? 's' : ''} already
                      submitted from a previous run
                    </span>
                    {!confirmRetract ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirmRetract(true)}
                        disabled={retracting || retractResults.size > 0}
                        className="h-7 gap-1.5 text-xs"
                      >
                        {retracting ? (
                          <>
                            <Loader2 size={13} className="animate-spin" />
                            Retracting…
                          </>
                        ) : retractResults.size > 0 ? (
                          <>
                            <Check size={13} />
                            Refilled
                          </>
                        ) : (
                          <>Retract &amp; refill {submittedMappings.length}</>
                        )}
                      </Button>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          onClick={handleRetractRefill}
                          disabled={retracting}
                          className="h-7 text-xs"
                        >
                          Confirm
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmRetract(false)}
                          disabled={retracting}
                          className="h-7 text-xs"
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                  {confirmRetract && (
                    <p className="text-[11px] text-muted-foreground">
                      Retracts each submitted result and fills the fresh copy with the value
                      below — the previous values stay in the sample&apos;s history as
                      retracted. You review and submit afterwards, same as the first run.
                    </p>
                  )}
                  <div className="grid gap-1.5">
                    {submittedMappings.map(m => {
                      const uid = m.analysis.uid ?? ''
                      const status = retractResults.get(uid)
                      return (
                        <div key={uid} className="flex items-center gap-2 text-xs">
                          {status === 'success' ? (
                            <Check size={12} className="text-emerald-600 shrink-0" />
                          ) : status === 'error' ? (
                            <X size={12} className="text-destructive shrink-0" />
                          ) : (
                            <div className="w-3 h-3 rounded-full border border-amber-400/60 shrink-0" />
                          )}
                          <span className="text-muted-foreground">{displayTitle(m)}</span>
                          <span className="font-mono text-muted-foreground line-through">
                            {m.analysis.result ?? '—'}
                          </span>
                          <span aria-hidden className="text-muted-foreground">→</span>
                          <span className="text-foreground font-mono font-medium">{m.label}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {(verifiedLockedCount > 0 || nativeSubmittedCount > 0) && (
                <p className="text-[11px] text-muted-foreground">
                  {verifiedLockedCount > 0 && (
                    <>
                      {verifiedLockedCount} verified result{verifiedLockedCount !== 1 ? 's' : ''} can&apos;t
                      be refilled — a verified value needs a retest via the verification flow.
                    </>
                  )}
                  {verifiedLockedCount > 0 && nativeSubmittedCount > 0 && ' '}
                  {nativeSubmittedCount > 0 && (
                    <>
                      {nativeSubmittedCount} native submitted row{nativeSubmittedCount !== 1 ? 's' : ''} —
                      manage in the analyses table below.
                    </>
                  )}
                </p>
              )}
            </div>
          )}

          {/* AnalysisTable — handles all inline editing + transitions */}
          <AnalysisTable
            analyses={analyses}
            analyteNameMap={analyteNameMap}
            onResultSaved={handleResultSaved}
            onTransitionComplete={handleTransitionComplete}
            onMethodInstrumentSaved={handleMethodInstrumentSaved}
          />

          {/* Complete HPLC button */}
          {prep.status !== 'hplc_complete' && prep.status !== 'completed' && (
            <CompleteHplcButton prepId={prep.id} onComplete={onComplete} />
          )}
        </div>
      )}

      {/* Empty state */}
      {!senaiteData && !loading && !error && (
        <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
          <FlaskConical size={32} className="opacity-30" />
          <p className="text-sm">Enter a Sample ID above and press Load</p>
        </div>
      )}
    </div>
  )
}

export function CompleteHplcButton({ prepId, onComplete }: { prepId: number; onComplete?: () => void }) {
  const [completing, setCompleting] = useState(false)
  const [done, setDone] = useState(false)

  async function handleComplete() {
    setCompleting(true)
    try {
      await updateSamplePrep(prepId, { status: 'hplc_complete' })
      setDone(true)
      toast.success('Sample prep marked as HPLC Complete')
      onComplete?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to complete')
    } finally {
      setCompleting(false)
    }
  }

  if (done) {
    return (
      <div className="flex items-center justify-center gap-2 py-4 text-sm text-green-500">
        <CheckCircle2 size={16} />
        HPLC Complete
      </div>
    )
  }

  return (
    <div className="border-t border-border/50 pt-4 mt-4">
      <Button
        onClick={handleComplete}
        disabled={completing}
        className="w-full bg-teal-600 hover:bg-teal-700 text-white"
      >
        {completing ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Completing...
          </>
        ) : (
          <>
            <Check className="mr-2 h-4 w-4" />
            Mark HPLC Complete
          </>
        )}
      </Button>
      <p className="text-[10px] text-muted-foreground text-center mt-1.5">
        Confirms HPLC processing is done for this sample prep
      </p>
    </div>
  )
}
