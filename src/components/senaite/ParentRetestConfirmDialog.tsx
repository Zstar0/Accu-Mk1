import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { ParentRetestImpact } from '@/lib/native-parent-analyses'

export interface ParentRetestConfirmState {
  titles: string[]
  keywords: string[]
  impact: ParentRetestImpact
}

/** Destructive confirm for the native parent-tier retest. Names the exact
 *  blast radius (N promoted source results on vials X, Y) and fails closed:
 *  with no promotion provenance the cascade would silently no-op, so the
 *  action is disabled rather than offering a do-nothing button. */
export function ParentRetestConfirmDialog({
  state, pending, onCancel, onConfirm,
}: {
  state: ParentRetestConfirmState | null
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const impact = state?.impact
  const blocked = !impact || impact.sourceCount === 0
  return (
    <AlertDialog open={!!state} onOpenChange={open => { if (!open && !pending) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {state && state.titles.length > 1
              ? `Retest ${state.titles.length} analyses?`
              : 'Retest analysis?'}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <div><strong>{state?.titles.join(', ')}</strong></div>
              {blocked ? (
                <div>
                  No promoted source results found for this row — a retest here
                  would have no effect. Retest the vial rows directly instead.
                </div>
              ) : (
                <div>
                  This retracts {impact.sourceCount} promoted source{' '}
                  {impact.sourceCount === 1 ? 'result' : 'results'}
                  {impact.vialIds.length > 0 && (
                    <> on vial{impact.vialIds.length === 1 ? '' : 's'}{' '}
                      <span className="font-mono">{impact.vialIds.join(', ')}</span></>
                  )}
                  , creates fresh retest rows there, and un-promotes this parent
                  result. Published COAs are not affected.
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
