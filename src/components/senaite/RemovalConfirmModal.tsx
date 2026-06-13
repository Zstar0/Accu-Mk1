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
  /** When true, blocked (verified/promoted) rows can be force-retracted under a
   *  strong confirm instead of hard-blocking (the wrong-variant Replace case).
   *  Published rows never reach here — the endpoint refuses them up front. */
  forceable?: boolean
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
  forceable = false,
  onConfirm,
  onCancel,
}: RemovalConfirmModalProps) {
  const blocked = impact?.blocked ?? []
  const worked = impact?.worked_unverified ?? []
  const hasBlocked = blocked.length > 0
  const workedCount = worked.length + (forceable ? blocked.length : 0)
  const workedVials = new Set(
    [...worked, ...(forceable ? blocked : [])].map(r => r.sample_id),
  ).size

  // Hard block only when blocked rows exist AND this caller can't force them.
  const hardBlocked = hasBlocked && !forceable
  const escalated = hasBlocked && forceable

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onCancel() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {hardBlocked
              ? <ShieldX size={18} className="text-destructive" />
              : <AlertTriangle size={18} className={escalated ? 'text-destructive' : 'text-amber-500'} />}
            {hardBlocked ? 'Cannot remove yet'
              : escalated ? 'Retract finalized results?'
              : 'Remove entered results?'}
          </DialogTitle>
        </DialogHeader>

        <div className="text-sm text-muted-foreground space-y-2">
          <p><span className="font-medium text-foreground">{serviceTitle}</span></p>
          {hardBlocked ? (
            <p>
              {blocked.length} vial result{blocked.length === 1 ? ' is' : 's are'}{' '}
              verified or on a published COA, so this service can't be removed here.
              Invalidate or retest {blocked.length === 1 ? 'it' : 'those'} first.
            </p>
          ) : escalated ? (
            <p>
              <span className="text-foreground font-medium">{blocked.length} verified/promoted</span>
              {worked.length ? ` and ${worked.length} in-progress` : ''} result
              {workedCount === 1 ? '' : 's'} across {workedVials} vial
              {workedVials === 1 ? '' : 's'} will be retracted (canonical results
              un-promoted) and kept as an audited record. This is for correcting a
              wrong analyte — published COAs are not affected.
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
            {hardBlocked ? 'Close' : 'Cancel'}
          </Button>
          {!hardBlocked && (
            <Button variant="destructive" onClick={onConfirm} disabled={pending}>
              {pending ? 'Working…' : escalated ? 'Force retract & replace' : 'Retract & remove'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
