import { useState, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { setAnalysisResult, type SenaiteAnalysis } from '@/lib/api'

// --- Types ---

interface UseAnalysisEditingOptions {
  analyses: SenaiteAnalysis[]
  onResultSaved?: (uid: string, newResult: string, newReviewState: string | null) => void
}

export interface UseAnalysisEditingReturn {
  editingUid: string | null
  draft: string
  isSaving: boolean
  startEditing: (uid: string, currentResult: string | null) => void
  cancelEditing: () => void
  setDraft: (value: string) => void
  handleKeyDown: (e: React.KeyboardEvent, uid: string) => void
  save: (uid: string) => Promise<void>
  /** Ref guard — exposed so onBlur can check before cancelling */
  savePendingRef: React.RefObject<boolean>
}

/** States that indicate an analysis is editable (result can be set). */
const EDITABLE_STATES = new Set<string | null>(['unassigned', null])

function isEditable(a: SenaiteAnalysis): boolean {
  return !!a.uid && EDITABLE_STATES.has(a.review_state)
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
    async (uid: string) => {
      if (savePendingRef.current) return
      savePendingRef.current = true
      setIsSaving(true)

      try {
        const response = await setAnalysisResult(uid, draft.trim())
        if (response.success) {
          onResultSaved?.(uid, draft.trim(), response.new_review_state)
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
    [draft, onResultSaved, cancelEditing]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, uid: string) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        // Save, then advance is NOT needed on Enter — just save
        save(uid)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancelEditing()
      } else if (e.key === 'Tab') {
        e.preventDefault()
        // Save current, then advance to next editable cell
        const currentIndex = analyses.findIndex(a => a.uid === uid)
        if (currentIndex === -1) {
          save(uid)
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

        save(uid).then(() => {
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
