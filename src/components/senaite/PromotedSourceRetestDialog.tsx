import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export interface PromotedSourceRetestState {
  title: string
  parentSampleId: string
  /** The parent-tier row's current review_state for this keyword, resolved
   *  just before the dialog opens (newest row for the keyword). null when
   *  it couldn't be resolved (fetch failed, or no matching parent row) —
   *  the dialog fails closed on that, same as an unrecognized state. */
  parentState: string | null
}

const UNVERIFIES_PARENT = new Set(['verified', 'parent_to_verify'])

/** Warning confirm for the vial-side (source) retest of a promoted, native
 *  (mk1-origin) row — the up-cascade mirror of ParentRetestConfirmDialog.
 *  Copy branches on the PARENT's current state, since the blast radius is
 *  state-dependent: a verified/awaiting parent gets un-verified by the
 *  retest, a published parent (a citable COA source) is left untouched.
 *  Fails closed when the parent state can't be resolved — same pattern as
 *  ParentRetestConfirmDialog's no-promotion-record case, and the PR #95
 *  lessons it shipped: Radix AlertDialogAction auto-closes unless
 *  preventDefault'd, so onConfirm doesn't dismiss the dialog itself; the
 *  dismissal guard and Cancel button both respect `pending`. */
export function PromotedSourceRetestDialog({
  state, pending, onCancel, onConfirm,
}: {
  state: PromotedSourceRetestState | null
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const parentState = state?.parentState ?? null
  const known = UNVERIFIES_PARENT.has(parentState ?? '') || parentState === 'published'
  const blocked = !state || !known
  return (
    <AlertDialog open={!!state} onOpenChange={open => { if (!open && !pending) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Retest analysis?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <div><strong>{state?.title}</strong></div>
              {blocked ? (
                <div>
                  The parent value&apos;s current state could not be
                  determined — the promotion record may still be loading, or
                  failed to load. Retest is unavailable here until it can be
                  shown.
                </div>
              ) : parentState === 'published' ? (
                <div>
                  The published parent value and its COA are NOT touched. The
                  re-run&apos;s new value cannot be re-promoted until the
                  COA-snapshot release.
                </div>
              ) : (
                <div>
                  Retesting this promoted result will un-verify the parent
                  value on <span className="font-mono">{state?.parentSampleId}</span>{' '}
                  — it returns to awaiting re-promotion.
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={blocked || pending} onClick={e => { e.preventDefault(); onConfirm() }}>
            {pending ? 'Retesting…' : 'Retest'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
