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
  onClose: () => void
  onCancelled: () => void
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/**
 * Cancel a sample at any point in the process (customer request). Dry-run
 * preview on open; requires a reason and the sample id typed back. When a
 * COA is already published it says so: cancelling never withdraws it.
 */
export function CancelSampleDialog({
  open,
  sampleId,
  currentStatus,
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
  const canSubmit =
    preview !== null && reason.trim().length >= 3 && confirmMatches && !pending

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
        {preview === null && previewError === null && (
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
            <span>Could not preview the change: {previewError}</span>
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
            disabled={preview === null}
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
            disabled={preview === null}
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
