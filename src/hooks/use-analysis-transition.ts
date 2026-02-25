import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { transitionAnalysis } from '@/lib/api'

// --- Types ---

interface UseAnalysisTransitionOptions {
  onTransitionComplete?: () => void
}

export interface PendingConfirm {
  uid: string
  transition: string
  analysisTitle: string
}

export interface UseAnalysisTransitionReturn {
  pendingUids: Set<string>
  pendingConfirm: PendingConfirm | null
  executeTransition: (uid: string, transition: string) => Promise<void>
  requestConfirm: (uid: string, transition: string, analysisTitle: string) => void
  cancelConfirm: () => void
  confirmAndExecute: () => Promise<void>
}

const TRANSITION_LABELS: Record<string, string> = {
  submit: 'Submit',
  verify: 'Verify',
  retract: 'Retract',
  reject: 'Reject',
}

// --- Hook ---

export function useAnalysisTransition({
  onTransitionComplete,
}: UseAnalysisTransitionOptions = {}): UseAnalysisTransitionReturn {
  const [pendingUids, setPendingUids] = useState<Set<string>>(new Set())
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)

  const executeTransition = useCallback(
    async (uid: string, transition: string) => {
      setPendingUids(prev => new Set(prev).add(uid))

      try {
        const response = await transitionAnalysis(
          uid,
          transition as 'submit' | 'verify' | 'retract' | 'reject'
        )
        if (response.success) {
          const label = TRANSITION_LABELS[transition] ?? transition
          toast.success(`${label} successful`)
          onTransitionComplete?.()
        } else {
          toast.error('Transition failed', { description: response.message })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        toast.error('Transition failed', { description: msg })
      } finally {
        setPendingUids(prev => {
          const next = new Set(prev)
          next.delete(uid)
          return next
        })
      }
    },
    [onTransitionComplete]
  )

  const requestConfirm = useCallback(
    (uid: string, transition: string, analysisTitle: string) => {
      setPendingConfirm({ uid, transition, analysisTitle })
    },
    []
  )

  const cancelConfirm = useCallback(() => {
    setPendingConfirm(null)
  }, [])

  const confirmAndExecute = useCallback(async () => {
    if (!pendingConfirm) return
    const { uid, transition } = pendingConfirm
    setPendingConfirm(null)
    await executeTransition(uid, transition)
  }, [pendingConfirm, executeTransition])

  return {
    pendingUids,
    pendingConfirm,
    executeTransition,
    requestConfirm,
    cancelConfirm,
    confirmAndExecute,
  }
}
