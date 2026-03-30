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
  updateSamplePrep,
  uploadChromatogramToSenaite,
  renderChromatogramImage,
  type SamplePrep,
  type HPLCAnalysisResult,
  type SenaiteLookupResult,
  type SenaiteAnalysis,
} from '@/lib/api'
import { AnalysisTable, StatusBadge } from '@/components/senaite/AnalysisTable'

// ── Auto-fill mapping ─────────────────────────────────────────────────────────

/** States where we can write a result value. */
const FILLABLE_STATES = new Set<string | null>(['unassigned', 'assigned', null])

interface AutoFillMapping {
  analysis: SenaiteAnalysis
  value: string
  label: string
  type: 'purity' | 'quantity' | 'identity'
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
 * Build a list of Senaite analyses that can be auto-filled from a single HPLC result.
 */
function buildAutoFillMappings(
  result: HPLCAnalysisResult,
  analyses: SenaiteAnalysis[],
): AutoFillMapping[] {
  const peptide = result.peptide_abbreviation?.toLowerCase()
  if (!peptide) return []

  const mappings: AutoFillMapping[] = []

  for (const a of analyses) {
    if (!a.uid) continue
    if (!FILLABLE_STATES.has(a.review_state)) continue

    const name = (a.title ?? a.keyword ?? '').toLowerCase()
    if (!isRelevantAnalysis(name, peptide)) continue

    if (name.includes('purity') && result.purity_percent != null) {
      mappings.push({
        analysis: a,
        value: result.purity_percent.toFixed(2),
        label: `${result.purity_percent.toFixed(2)}%`,
        type: 'purity',
      })
    } else if (name.includes('quantity') && result.quantity_mg != null) {
      mappings.push({
        analysis: a,
        value: result.quantity_mg.toFixed(2),
        label: `${result.quantity_mg.toFixed(2)} mg`,
        type: 'quantity',
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
      })
    }
  }

  return mappings
}

/**
 * Aggregate auto-fill mappings from multiple HPLC results (blend support).
 * Per-analyte matches (e.g. "KPV Purity") are claimed first; generic matches
 * (e.g. "Peptide Purity") only fill if unclaimed.
 */
function buildAllAutoFillMappings(
  results: HPLCAnalysisResult[],
  analyses: SenaiteAnalysis[],
): AutoFillMapping[] {
  const allMappings: AutoFillMapping[] = []
  const claimed = new Set<string>()

  for (const result of results) {
    const mappings = buildAutoFillMappings(result, analyses)
    for (const m of mappings) {
      const uid = m.analysis.uid ?? ''
      if (!claimed.has(uid)) {
        claimed.add(uid)
        allMappings.push(m)
      }
    }
  }
  return allMappings
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

  // Chromatogram preview
  const [chromUrl, setChromUrl] = useState<string | null>(null)
  const [chromLoading, setChromLoading] = useState(false)

  // Render chromatogram image on mount (from first result with chromatogram data)
  const chromAnalysisId = hplcResults.find(r => r.chromatogram_data?.times?.length)?.id ?? null

  useEffect(() => {
    if (!chromAnalysisId || chromUrl) return
    let revoked = false
    setChromLoading(true)
    renderChromatogramImage(chromAnalysisId)
      .then(url => { if (!revoked) setChromUrl(url) })
      .catch(e => console.warn('[Chromatogram] render failed:', e))
      .finally(() => { if (!revoked) setChromLoading(false) })
    return () => {
      revoked = true
      if (chromUrl) URL.revokeObjectURL(chromUrl)
    }
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

  // Build analyteNameMap from loaded data
  const analyteNameMap = new Map<number, string>()
  if (senaiteData) {
    for (const analyte of senaiteData.analytes) {
      const displayName =
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
  const autoFillMappings = senaiteData ? buildAllAutoFillMappings(hplcResults, analyses) : []

  // ── Auto-fill handler ───────────────────────────────────────────────────────

  const handleAutoFill = useCallback(async () => {
    if (autoFillMappings.length === 0) return
    setFilling(true)
    const results = new Map<string, 'success' | 'error'>()

    for (const mapping of autoFillMappings) {
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
          .then(r => { if (r.success) toast.success('Chromatogram image uploaded to SENAITE') })
          .catch(() => { /* best-effort — don't block the user */ })
      }
    }
  }, [autoFillMappings, senaiteData, hplcResults])

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
              const totalQty = hplcResults.reduce((sum, r) => sum + (r.quantity_mg ?? 0), 0)
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
      {(chromUrl || chromLoading) && (
        <div className="px-6 pt-4 pb-4 border-b border-border/60">
          <div className="rounded-lg border border-border bg-card p-4 space-y-2">
            <h3 className="text-sm font-semibold">Chromatogram</h3>
            {chromLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner className="size-5" />
                <span className="ml-2 text-sm text-muted-foreground">Rendering chromatogram...</span>
              </div>
            ) : chromUrl ? (
              <img
                src={chromUrl}
                alt="HPLC Chromatogram"
                className="w-full rounded border border-border/50"
              />
            ) : null}
            <p className="text-xs text-muted-foreground">
              This image will be uploaded to SENAITE when you auto-fill results.
            </p>
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
          {autoFillMappings.length > 0 && (
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
                      Fill {autoFillMappings.length} result{autoFillMappings.length !== 1 ? 's' : ''}
                    </>
                  )}
                </Button>
              </div>

              <div className="grid gap-1.5">
                {autoFillMappings.map(m => {
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
                      <span className="text-muted-foreground">{m.analysis.title}</span>
                      <span className="text-foreground font-mono font-medium">{m.label}</span>
                    </div>
                  )
                })}
              </div>
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

function CompleteHplcButton({ prepId, onComplete }: { prepId: number; onComplete?: () => void }) {
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
