import { useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  unpromoteAnalysis,
  unverifyVarianceAnalysis,
  type SenaiteAnalysis,
} from '@/lib/api'

/**
 * Unlock a signed-off vial result (vial unlock spec 2026-07-03).
 *
 * promoted rows          → POST /unpromote (retracts the parent value and
 *                          reverts EVERY vial in the promotion group)
 * variance_verified rows → kind=unverify transition (single row)
 *
 * The reason is required — it lands on the audit trail (ISO 17025 7.5.2).
 */
export function UnlockDialog({
  analysis,
  open,
  onOpenChange,
  onUnlocked,
}: {
  analysis: SenaiteAnalysis
  open: boolean
  onOpenChange: (open: boolean) => void
  onUnlocked: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const isPromoted = analysis.review_state === 'promoted'

  const confirm = async () => {
    if (!reason.trim() || !analysis.uid) return
    setBusy(true)
    try {
      if (isPromoted) {
        if (analysis.promoted_to_parent_id == null) return
        await unpromoteAnalysis(analysis.promoted_to_parent_id, reason.trim())
      } else {
        await unverifyVarianceAnalysis(analysis.uid, reason.trim())
      }
      toast.success('Result unlocked — back to To Be Verified')
      onOpenChange(false)
      setReason('')
      onUnlocked()
    } catch (err) {
      toast.error('Unlock failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unlock {analysis.title}</DialogTitle>
          <DialogDescription>
            {isPromoted
              ? 'Retracts the promoted parent value and returns every vial in this promotion group to To Be Verified. Retest / re-verify / re-promote as needed afterwards.'
              : 'Returns this variance replicate to To Be Verified so it can be corrected and re-verified.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="unlock-reason">Reason (required)</Label>
          <Input
            id="unlock-reason"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="e.g. data-entry swap — purity entered as quantity"
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void confirm()}
            disabled={busy || !reason.trim()}
          >
            Unlock
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
