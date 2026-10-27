import { useState, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { setAnalysisResult, type SenaiteAnalysis } from '@/lib/api'

// --- Types ---

interface UseAnalysisEditingOptions {
  analyses: SenaiteAnalysis[]
  /** `newUnit` is the unit the save stored (native rows with unit options);
   *  undefined when the save sent none. */
  onResultSaved?: (
    uid: string,
    newResult: string,
    newReviewState: string | null,
    newUnit?: string | null
  ) => void
}

export interface UseAnalysisEditingReturn {
  editingUid: string | null
  draft: string
  isSaving: boolean
  startEditing: (uid: string, currentResult: string | null) => void
  cancelEditing: () => void
  setDraft: (value: string) => void
  /** Pass unitOverride when the analyst has picked a unit in the cell. */
  handleKeyDown: (
    e: React.KeyboardEvent,
    uid: string,
    unitOverride?: string
  ) => void
  /** Pass valueOverride to save a specific value instead of the current draft (used by autoEdit inline inputs).
   *  Pass unitOverride for a unit the analyst picked; otherwise a native row
   *  sends the unit it shows (see presetUnit). */
  save: (
    uid: string,
    valueOverride?: string,
    unitOverride?: string
  ) => Promise<void>
  /** Ref guard — exposed so onBlur can check before cancelling */
  savePendingRef: React.RefObject<boolean>
}

/** States that indicate an analysis is editable (result can be set).
 *  Mk1 vial-tier rows stay editable through to_be_verified (in-place result
 *  correction before promote/variance-verify); SENAITE-backed rows keep the
 *  stricter set. Mirrors isResultEditable in AnalysisTable.tsx. */
const EDITABLE_STATES = new Set<string | null>(['unassigned', 'assigned', null])
const MK1_EDITABLE_STATES = new Set<string | null>([
  'unassigned', 'assigned', 'to_be_verified', null,
])

function isEditable(a: SenaiteAnalysis): boolean {
  if (!a.uid) return false
  return a.uid.startsWith('mk1:')
    ? MK1_EDITABLE_STATES.has(a.review_state)
    : EDITABLE_STATES.has(a.review_state)
}

/** The units a row offers at result entry. Native (mk1:) rows only; a SENAITE
 *  row never sends a unit. */
export function unitChoices(a: SenaiteAnalysis | undefined): string[] {
  return a?.uid?.startsWith('mk1:') ? (a.unit_options ?? []) : []
}

/** Several units on offer, the sample's form picks none, and nothing is
 *  resulted yet: the analyst must pick one, so nothing saves until they do. */
export function unitPickRequired(a: SenaiteAnalysis | undefined): boolean {
  return (
    !!a && !a.result && unitChoices(a).length > 1 && a.default_unit === null
  )
}

/** The unit a row shows before the analyst touches the dropdown, and the one a
 *  save sends when they never do. null = none (a SENAITE row, no options, a
 *  stored unit outside the options, or a pick-required row). */
export function presetUnit(a: SenaiteAnalysis | undefined): string | null {
  if (!a || unitPickRequired(a)) return null
  return a.unit && unitChoices(a).includes(a.unit) ? a.unit : null
}

// --- Hook ---

export function useAnalysisEditing({
  analyses,
  onResultSaved,
}: UseAnalysisEditingOptions): UseAnalysisEditingReturn {
  const [editingUid, setEditingUid] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const savePendingRef = useRef(false)

  const cancelEditing = useCallback(() => {
    setEditingUid(null)
    setDraft('')
  }, [])

  const startEditing = useCallback((uid: string, currentResult: string | null) => {
    savePendingRef.current = false
    setEditingUid(uid)
    setDraft(currentResult ?? '')
  }, [])

  const save = useCallback(
    async (uid: string, valueOverride?: string, unitOverride?: string) => {
      if (savePendingRef.current) return
      const row = analyses.find(a => a.uid === uid)
      const unit = unitOverride ?? presetUnit(row) ?? undefined
      if (!unit && unitPickRequired(row)) {
        toast.error('Pick a unit first', {
          description: `${row?.title ?? 'This analysis'} has more than one unit. Choose one to save the result.`,
        })
        return
      }
      savePendingRef.current = true
      setIsSaving(true)
      const valueToSave = valueOverride !== undefined ? valueOverride : draft.trim()

      try {
        const response = await setAnalysisResult(uid, valueToSave, unit)
        if (response.success) {
          onResultSaved?.(uid, valueToSave, response.new_review_state, unit)
          toast.success('Result saved')
          cancelEditing()
        } else {
          toast.error('Failed to save result', { description: response.message })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        toast.error('Failed to save result', { description: msg })
      } finally {
        setIsSaving(false)
        savePendingRef.current = false
      }
    },
    [analyses, draft, onResultSaved, cancelEditing]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, uid: string, unitOverride?: string) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        // Save, then advance is NOT needed on Enter — just save
        save(uid, undefined, unitOverride)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancelEditing()
      } else if (e.key === 'Tab') {
        e.preventDefault()
        // A row that needs a unit pick cannot save yet: stay on it (the save
        // explains why) so advancing does not discard the typed value.
        if (
          !unitOverride &&
          unitPickRequired(analyses.find(a => a.uid === uid))
        ) {
          void save(uid)
          return
        }
        // Save current, then advance to next editable cell
        const currentIndex = analyses.findIndex(a => a.uid === uid)
        if (currentIndex === -1) {
          save(uid, undefined, unitOverride)
          return
        }

        // Find next editable analysis (wrap not needed per spec — stop at end)
        let nextAnalysis: SenaiteAnalysis | null = null
        for (let i = currentIndex + 1; i < analyses.length; i++) {
          const candidate = analyses[i]
          if (candidate && isEditable(candidate)) {
            nextAnalysis = candidate
            break
          }
        }

        save(uid, undefined, unitOverride).then(() => {
          if (nextAnalysis?.uid) {
            // Only start editing next if the save succeeded (editing was cancelled)
            // We need a small delay so React state settles from cancelEditing()
            setTimeout(() => {
              if (nextAnalysis.uid) {
                startEditing(nextAnalysis.uid, nextAnalysis.result)
              }
            }, 0)
          }
        })
      }
    },
    [analyses, save, cancelEditing, startEditing]
  )

  return {
    editingUid,
    draft,
    isSaving,
    startEditing,
    cancelEditing,
    setDraft,
    handleKeyDown,
    save,
    savePendingRef,
  }
}
