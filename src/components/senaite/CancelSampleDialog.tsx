import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cancelSample, type CancelSamplePreview } from '@/lib/api'

interface Props {
  open: boolean
  sampleId: string
  currentStatus: string
  statusAuthority?: 'senaite' | 'mk1'
  onClose: () => void
  onCancelled: () => void
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
// SENAITE's guard_cancel only returns True while EVERY analysis is still
// unassigned/registered, and `to_be_verified` has no cancel exit at all —
// so in practice SENAITE stops allowing cancel at the first worksheet
// assignment, well before verification (corrected 2026-09-09, final review).
const SENAITE_LOCKED = new Set([
  'to_be_verified',
  'verified',
  'published',
  'waiting_for_addon_results',
])

/**
 * Cancel a sample at any point in the process (customer request). Dry-run
 * preview on open; requires a reason and the sample id typed back. When a
 * COA is already published it says so: cancelling never withdraws it.
 */
export function CancelSampleDialog({
  open,
  sampleId,
  currentStatus,
  statusAuthority = 'senaite',
  onClose,
  onCancelled,
}: Props) {
  const [preview, setPreview] = useState<CancelSamplePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setPreview(null)
    setPreviewError(null)
    setReason('')
    setTyped('')
    cancelSample(sampleId, { reason: 'preview', dryRun: true })
      .then(res => {
        if (!cancelled && res.dry_run) setPreview(res)
      })
      .catch((e: Error) => {
        if (!cancelled) setPreviewError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [open, sampleId])

  const confirmMatches = typed.trim().toLowerCase() === sampleId.toLowerCase()
  /** Only the in-flight preview blocks the form. A FAILED preview must not:
   *  the impact summary is a courtesy, the server is the authority, and
   *  gating on it left the operator with a disabled reason box and no way
   *  out (arcitest UAT, 2026-09-09). A cancel attempted without a preview
   *  surfaces the real server error as a toast. */
  const previewLoading = preview === null && previewError === null
  const canSubmit =
    !previewLoading && reason.trim().length >= 3 && confirmMatches && !pending

  async function doCancel() {
    setPending(true)
    try {
      await cancelSample(sampleId, { reason: reason.trim(), confirm: true })
      toast.success(`${sampleId} cancelled`)
      onCancelled()
      onClose()
    } catch (e) {
      toast.error('Cancel failed', { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={v => {
        if (!v && !pending) onClose()
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Cancel sample {sampleId}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground -mt-1">
          Current status: {currentStatus}. Cancelling stops all pending work on
          this sample.
        </p>
        {statusAuthority === 'senaite' && (
          <p className="text-xs text-muted-foreground -mt-1" data-testid="senaite-mode-note">
            Status authority is SENAITE: the status badge keeps following SENAITE until the
            authority is switched to Accu-Mk1. Pending work is still stopped and the
            cancellation is recorded in Accu-Mk1
            {SENAITE_LOCKED.has(currentStatus) ? '; SENAITE itself only allows cancel before any analysis is assigned, so the badge will not change until the flip.' : '.'}
          </p>
        )}
        {previewLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2 size={14} className="animate-spin" /> Checking what this
            would touch…
          </div>
        )}
        {previewError !== null && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            <AlertTriangle
              size={14}
              className="mt-0.5 shrink-0 text-destructive"
            />
            <span>
              Could not preview the change: {previewError}. You can still
              cancel — the impact summary above is unavailable, and any error
              is reported when you confirm.
            </span>
          </div>
        )}
        {preview !== null && (
          <ul className="space-y-1 text-sm">
            <li>
              {plural(preview.cancelled_rows.length, 'pending result')} will be
              cancelled.
            </li>
            <li>
              {plural(preview.released_worksheets.length, 'worksheet')} will
              release this sample.
            </li>
            {preview.published_coa_still_live && (
              <li className="text-amber-600 dark:text-amber-400">
                The published certificate and its AccuVerify page stay live.
                Cancelling does not withdraw them.
              </li>
            )}
          </ul>
        )}
        <label className="block text-xs text-muted-foreground mt-2">
          Reason
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            disabled={previewLoading}
            rows={2}
            className="mt-1 w-full px-3 py-2 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          />
        </label>
        <label className="block text-xs text-muted-foreground mt-2">
          Type {sampleId} to confirm
          <input
            type="text"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            disabled={previewLoading}
            autoComplete="off"
            className="mt-1 w-full px-3 py-2 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          />
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Keep sample
          </Button>
          <Button
            variant="destructive"
            onClick={doCancel}
            disabled={!canSubmit}
          >
            {pending ? 'Cancelling…' : 'Cancel sample'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
