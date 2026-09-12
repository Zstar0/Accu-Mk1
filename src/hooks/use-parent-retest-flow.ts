/**
 * Parent-tier retest confirm flow: request → destructive confirm →
 * dedicated parent-retest route (the generic transitions endpoint
 * tier-blocks parent retest).
 *
 * Extracted from NativeParentAnalysesCard (2026-08-28) so the read-flip
 * main table — the native parent surface in mk1 read mode — can share the
 * exact same confirm dialog and execution path instead of growing a copy.
 * The caller renders <ParentRetestConfirmDialog> with the returned state.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import {
  parentRetestAnalysis,
  type ParentPromotionInfo,
  type SenaiteAnalysis,
} from '@/lib/api'
import { buildBulkParentRetestImpact } from '@/lib/native-parent-analyses'
import type { ParentRetestConfirmState } from '@/components/senaite/ParentRetestConfirmDialog'

export function useParentRetestFlow({
  sampleId,
  promotionsByKeyword,
  onDone,
}: {
  sampleId: string | null | undefined
  promotionsByKeyword?: Map<string, ParentPromotionInfo>
  /** Runs after every execution attempt (finally) — refresh/invalidate the
   *  caller's surfaces here. */
  onDone?: () => void
}) {
  const [confirm, setConfirm] = useState<ParentRetestConfirmState | null>(null)
  const [retestPending, setRetestPending] = useState(false)

  const [targets, setTargets] = useState<SenaiteAnalysis[]>([])

  const requestRetest = (newTargets: SenaiteAnalysis[]) => {
    const keywords = newTargets.map(a => a.keyword).filter((k): k is string => !!k)
    setTargets(newTargets)
    setConfirm({
      titles: newTargets.map(a => a.title),
      keywords,
      impact: buildBulkParentRetestImpact(keywords, promotionsByKeyword),
      publishedTitles: newTargets
        .filter(a => a.review_state === 'published')
        .map(a => a.title),
    })
  }

  const executeRetest = async () => {
    if (!confirm || !sampleId) return
    setRetestPending(true)
    try {
      let retested = 0
      for (const target of targets) {
        if (!target.keyword) continue
        // Native per-slot rows carry a numeric `slot`; only those need
        // analysis_service_id + slot on the wire so the backend can
        // disambiguate the slot. Legacy (SENAITE-born) targets keep the
        // original {keyword} / {keyword, reason} body untouched.
        const resp = await parentRetestAnalysis(
          sampleId,
          target.keyword,
          undefined,
          typeof target.slot === 'number'
            ? { analysis_service_id: target.analysis_service_id, slot: target.slot }
            : undefined
        )
        retested += resp.new_row_ids.length
      }
      if (retested > 0) {
        toast.success(
          `Retest cascaded — ${retested} source row${retested === 1 ? '' : 's'} retested`
        )
      } else {
        toast.warning('No eligible source rows — nothing changed')
      }
    } catch (e) {
      toast.error('Parent retest failed', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setRetestPending(false)
      setConfirm(null)
      onDone?.()
    }
  }

  const cancelRetest = () => setConfirm(null)

  return { confirm, retestPending, requestRetest, executeRetest, cancelRetest }
}
