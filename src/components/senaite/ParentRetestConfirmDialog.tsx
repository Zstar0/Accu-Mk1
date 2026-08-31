import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { ParentRetestImpact } from '@/lib/native-parent-analyses'

export interface ParentRetestConfirmState {
  titles: string[]
  keywords: string[]
  impact: ParentRetestImpact
  /** Titles of targets whose parent row is PUBLISHED (published-parent-
   *  retest ruling 2026-08-28): those keep their citable value live until
   *  the retest's re-promote supersedes it, so the dialog copy must not
   *  claim an un-promote. Omitted/empty → existing copy verbatim. */
  publishedTitles?: string[]
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
  const publishedCount = state?.publishedTitles?.length ?? 0
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
                  No promoted source results are visible for this row — the
                  promotion record may still be loading, or failed to load.
                  Retest is unavailable here until it can be shown.
                </div>
              ) : (
                <>
                  <div>
                    This retracts {impact.sourceCount} promoted source{' '}
                    {impact.sourceCount === 1 ? 'result' : 'results'}
                    {impact.vialIds.length > 0 && (
                      <> on vial{impact.vialIds.length === 1 ? '' : 's'}{' '}
                        <span className="font-mono">{impact.vialIds.join(', ')}</span></>
                    )}
                    {publishedCount === 0 ? (
                      <>, creates fresh retest rows there, and un-promotes this
                        parent result. Published COAs are not affected.</>
                    ) : publishedCount < (state?.titles.length ?? 0) ? (
                      <>, creates fresh retest rows there, and un-promotes the
                        not-yet-published parent results.</>
                    ) : (
                      <> and creates fresh retest rows there.</>
                    )}
                  </div>
                  {publishedCount > 0 && (
                    <div>
                      {publishedCount === 1
                        ? 'This result is PUBLISHED: its'
                        : `${publishedCount} of these results are PUBLISHED: each`}{' '}
                      published value stays on the issued certificate until the
                      retested result is promoted and verified over it. The
                      existing COA PDF is unchanged until it is regenerated.
                    </div>
                  )}
                </>
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
