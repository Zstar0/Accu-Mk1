/**
 * VialResultsView
 *
 * Final flyout step for VIAL-SCOPED sample preps (prep.lims_sub_sample_pk set).
 * Counterpart to SenaiteResultsView, but the write target is the vial's Mk1
 * lims_analyses rows — never the parent's SENAITE analyses. There is no
 * sample-ID input: the target is the prep's vial, period.
 *
 * The prep bridge (backend/lims_analyses/prep_bridge.py) already auto-writes
 * results when the HPLC analysis is saved; this view shows that outcome, lets
 * the tech re-run the idempotent bridge for anything still unassigned, and
 * hosts the same AnalysisTable used on the vial details page for manual entry
 * and submit/verify transitions.
 *
 * The chromatogram CSV still uploads to the PARENT AR in SENAITE (COA
 * generation reads it from there) — fired alongside Auto-fill, best-effort.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { ArrowLeft, FlaskConical, AlertTriangle, Zap, Check, Loader2, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import {
  listLimsAnalysesForSubSample,
  rebridgeSamplePrep,
  lookupSenaiteSample,
  uploadChromatogramToSenaite,
  renderChromatogramImage,
  type SamplePrep,
  type HPLCAnalysisResult,
  type SenaiteAnalysis,
} from '@/lib/api'
import { AnalysisTable } from '@/components/senaite/AnalysisTable'
import { patchAnalysisInList } from '@/components/senaite/vial-quicklook-helpers'
import { CompleteHplcButton } from '@/components/hplc/SenaiteResultsView'

interface Props {
  prep: SamplePrep
  results: HPLCAnalysisResult[]
  onBack: () => void
  onComplete?: () => void
}

export function VialResultsView({ prep, results: hplcResults, onBack, onComplete }: Props) {
  const vialId = prep.senaite_sample_id ?? prep.sample_id
  const [analyses, setAnalyses] = useState<SenaiteAnalysis[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [bridging, setBridging] = useState(false)
  const [bridged, setBridged] = useState(false)

  // Chromatogram preview (same behavior as SenaiteResultsView)
  const [chromUrl, setChromUrl] = useState<string | null>(null)
  const [chromLoading, setChromLoading] = useState(false)
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

  const loadAnalyses = useCallback(async () => {
    if (prep.lims_sub_sample_pk == null) return
    setError(null)
    try {
      const rows = await listLimsAnalysesForSubSample(prep.lims_sub_sample_pk)
      setAnalyses(rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load vial analyses')
    } finally {
      setLoading(false)
    }
  }, [prep.lims_sub_sample_pk])

  const didLoad = useRef(false)
  useEffect(() => {
    if (didLoad.current) return
    didLoad.current = true
    loadAnalyses()
  }, [loadAnalyses])

  // Derived counts — the bridge auto-submits to to_be_verified at analysis-save
  // time, so a healthy vial prep arrives here mostly pre-filled.
  const submittedCount = analyses.filter(
    a => a.review_state && a.review_state !== 'unassigned' && a.review_state !== 'assigned'
  ).length
  const unassignedCount = analyses.filter(
    a => !a.review_state || a.review_state === 'unassigned' || a.review_state === 'assigned'
  ).length

  const handleAutoFill = useCallback(async () => {
    setBridging(true)
    try {
      const { count } = await rebridgeSamplePrep(prep.id)
      setBridged(true)
      if (count > 0) {
        toast.success(`Filled ${count} vial result${count !== 1 ? 's' : ''} from the prep`)
      } else {
        toast.info('Nothing left to fill — all bridgeable results are already written')
      }
      await loadAnalyses()
    } catch (e) {
      toast.error('Auto-fill failed', {
        description: e instanceof Error ? e.message : 'Unknown error',
      })
    } finally {
      setBridging(false)
    }

    // Chromatogram CSV → PARENT AR in SENAITE (best-effort; COA reads it there).
    const firstResult = hplcResults[0]
    const parentId = vialId.replace(/-S\d+$/i, '')
    if (firstResult?.id && parentId && parentId !== vialId) {
      try {
        const parent = await lookupSenaiteSample(parentId)
        if (parent.sample_uid) {
          const r = await uploadChromatogramToSenaite(firstResult.id, parent.sample_uid)
          if (r.success) toast.success(`Chromatogram CSV uploaded to ${parentId} in SENAITE`)
        }
      } catch {
        // best-effort — don't block the user
      }
    }
  }, [prep.id, hplcResults, vialId, loadAnalyses])

  return (
    <div className="flex flex-col">
      {/* Back button + vial banner */}
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

        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-sky-600/20 to-sky-500/5 border border-sky-500/30 dark:border-sky-500/20">
            <FlaskConical size={18} className="text-sky-600 dark:text-sky-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold tracking-tight font-mono">{vialId}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Vial-scoped prep — results write to this vial&apos;s Mk1 analyses
              (verify &amp; promote stay manual)
            </p>
          </div>
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
          </div>
        </div>
      )}

      {/* Chromatogram preview */}
      {hplcResults.length > 0 && (chromLoading || chromUrl) && (
        <div className="px-6 pt-4 pb-4 border-b border-border/60">
          <div className="rounded-lg border border-border bg-card p-4 space-y-2">
            <h3 className="text-sm font-semibold">Chromatogram</h3>
            {chromLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner className="size-5" />
                <span className="ml-2 text-sm text-muted-foreground">Rendering chromatogram...</span>
              </div>
            ) : chromUrl ? (
              <>
                <img src={chromUrl} alt="HPLC Chromatogram" className="w-full rounded border border-border/50" />
                <p className="text-xs text-muted-foreground">
                  The chromatogram CSV uploads to the parent sample in SENAITE when you auto-fill.
                </p>
              </>
            ) : null}
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

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center gap-3 py-12">
          <Spinner className="size-6" />
          <p className="text-sm text-muted-foreground">Loading vial analyses…</p>
        </div>
      )}

      {!loading && !error && (
        <div className="px-6 py-5 space-y-5">
          {/* Bridge status + Auto-fill */}
          <div className="rounded-lg border border-sky-200 dark:border-sky-500/20 bg-sky-50/50 dark:bg-sky-500/5 p-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Zap size={15} className="text-sky-600 dark:text-sky-400" />
                <span className="text-sm font-medium">
                  {submittedCount > 0
                    ? `${submittedCount} vial result${submittedCount !== 1 ? 's' : ''} written by the prep bridge`
                    : 'No vial results written yet'}
                </span>
              </div>
              <Button
                size="sm"
                onClick={handleAutoFill}
                disabled={bridging}
                className="h-7 gap-1.5 text-xs"
              >
                {bridging ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    Filling…
                  </>
                ) : bridged ? (
                  <>
                    <Check size={13} />
                    Re-run Auto-fill
                  </>
                ) : (
                  <>
                    <Zap size={13} />
                    Auto-fill
                  </>
                )}
              </Button>
            </div>
            {unassignedCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {unassignedCount} row{unassignedCount !== 1 ? 's' : ''} still unfilled — Auto-fill
                re-runs the prep bridge (writes only rows it can match unambiguously); anything
                left can be entered manually below.
              </p>
            )}
          </div>

          {/* Counters */}
          {analyses.length > 0 && (
            <div className="flex items-center gap-5 text-center pb-1">
              <div>
                <div className="text-base font-bold text-emerald-700 dark:text-emerald-400">{submittedCount}</div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Filled</div>
              </div>
              <div className="w-px h-7 bg-border" />
              <div>
                <div className="text-base font-bold text-amber-600 dark:text-amber-400">{unassignedCount}</div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Pending</div>
              </div>
              <div className="w-px h-7 bg-border" />
              <div>
                <div className="text-base font-bold text-foreground">{analyses.length}</div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Total</div>
              </div>
            </div>
          )}

          {/* The vial's Mk1 analyses — same table the vial details page uses */}
          {analyses.length > 0 ? (
            <AnalysisTable
              analyses={analyses}
              analyteNameMap={new Map()}
              onResultSaved={(uid, newResult, newReviewState) =>
                setAnalyses(prev => patchAnalysisInList(prev, uid, newResult, newReviewState))
              }
              onTransitionComplete={loadAnalyses}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
              <FlaskConical size={28} className="opacity-30" />
              <p className="text-sm">No Mk1 analyses on this vial yet.</p>
              <p className="text-xs">
                Assign the vial a role (HPLC) so its analyses get seeded, then auto-fill.
              </p>
            </div>
          )}

          {/* Complete HPLC */}
          {prep.status !== 'hplc_complete' && prep.status !== 'completed' && (
            <CompleteHplcButton prepId={prep.id} onComplete={onComplete} />
          )}
        </div>
      )}
    </div>
  )
}
