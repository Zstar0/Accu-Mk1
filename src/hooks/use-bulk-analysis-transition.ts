import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { transitionAnalysis } from '@/lib/api'

// --- Types ---

export interface BulkProgress {
  current: number
  total: number
  transition: string
}

interface UseBulkAnalysisTransitionOptions {
  onTransitionComplete?: () => void
}

export interface UseBulkAnalysisTransitionReturn {
  selectedUids: Set<string>
  isBulkProcessing: boolean
  bulkProgress: BulkProgress | null
  toggleSelection: (uid: string) => void
  selectAll: (uids: string[]) => void
  clearSelection: () => void
  executeBulk: (uids: string[], transition: string) => Promise<void>
}

const TRANSITION_PAST_TENSE: Record<string, string> = {
  submit: 'submitted',
  verify: 'verified',
  retract: 'retracted',
  reject: 'rejected',
  retest: 'retested',
}

// --- Hook ---

export function useBulkAnalysisTransition({
  onTransitionComplete,
}: UseBulkAnalysisTransitionOptions = {}): UseBulkAnalysisTransitionReturn {
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set())
  const [isBulkProcessing, setIsBulkProcessing] = useState<boolean>(false)
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null)

  const toggleSelection = useCallback((uid: string) => {
    setSelectedUids(prev => {
      const next = new Set(prev)
      if (next.has(uid)) {
        next.delete(uid)
      } else {
        next.add(uid)
      }
      return next
    })
  }, [])

  const selectAll = useCallback((uids: string[]) => {
    setSelectedUids(new Set(uids))
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedUids(new Set())
  }, [])

  const executeBulk = useCallback(
    async (uids: string[], transition: string) => {
      setIsBulkProcessing(true)
      setBulkProgress({ current: 0, total: uids.length, transition })

      const succeeded: string[] = []
      const failed: string[] = []

      for (let i = 0; i < uids.length; i++) {
        setBulkProgress({ current: i + 1, total: uids.length, transition })
        try {
          const response = await transitionAnalysis(
            uids[i]!,
            transition as 'submit' | 'verify' | 'retract' | 'reject' | 'retest'
          )
          if (response.success) succeeded.push(uids[i]!)
          else failed.push(uids[i]!)
        } catch {
          failed.push(uids[i]!)
        }
      }

      onTransitionComplete?.()
      clearSelection()
      setIsBulkProcessing(false)
      setBulkProgress(null)

      const pastTense = TRANSITION_PAST_TENSE[transition] ?? transition
      if (failed.length === 0) {
        toast.success(`${succeeded.length} analyses ${pastTense}`)
      } else {
        toast.warning(`${succeeded.length} succeeded, ${failed.length} failed`, {
          description: `${failed.length} transition(s) could not be completed`,
        })
      }
    },
    [onTransitionComplete, clearSelection]
  )

  return {
    selectedUids,
    isBulkProcessing,
    bulkProgress,
    toggleSelection,
    selectAll,
    clearSelection,
    executeBulk,
  }
}
