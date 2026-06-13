import { AlertTriangle, ShieldX } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { RemovalImpact } from '@/lib/api'

interface RemovalConfirmModalProps {
  open: boolean
  serviceTitle: string
  impact: RemovalImpact | null
  /** True while the confirmed removal request is in flight. */
  pending?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirmation dialog for removing a Manage-Analyses service that already has
 * worked vial results. Two modes:
 *   - blocked: any vial has verified/published results → removal refused,
 *     confirm disabled, the tech is pointed at invalidate/retest.
 *   - worked: worked-but-unverified results will be retracted (kept as an
 *     audited record, restorable on re-add) → confirm enabled.
 * Voice mirrors the Manage Analyses help text ("…and it keeps a record").
 */
export function RemovalConfirmModal({
  open,
  serviceTitle,
  impact,
  pending = false,
  onConfirm,
  onCancel,
}: RemovalConfirmModalProps) {
  const blocked = impact?.blocked ?? []
  const worked = impact?.worked_unverified ?? []
  const isBlocked = blocked.length > 0
  const workedVials = new Set(worked.map(r => r.sample_id)).size

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onCancel() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isBlocked
              ? <ShieldX size={18} className="text-destructive" />
              : <AlertTriangle size={18} className="text-amber-500" />}
            {isBlocked ? 'Cannot remove yet' : 'Remove entered results?'}
          </DialogTitle>
        </DialogHeader>

        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            <span className="font-medium text-foreground">{serviceTitle}</span>
          </p>
          {isBlocked ? (
            <p>
              {blocked.length} vial result{blocked.length === 1 ? ' is' : 's are'}{' '}
              verified or on a published COA, so this service can't be removed here.
              Invalidate or retest {blocked.length === 1 ? 'it' : 'those'} first.
            </p>
          ) : (
            <p>
              This will retract {worked.length} entered result
              {worked.length === 1 ? '' : 's'} across {workedVials} vial
              {workedVials === 1 ? '' : 's'} and keep a record. Adding the service
              back later restores it on the vials.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            {isBlocked ? 'Close' : 'Cancel'}
          </Button>
          {!isBlocked && (
            <Button variant="destructive" onClick={onConfirm} disabled={pending}>
              {pending ? 'Removing…' : 'Retract & remove'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
