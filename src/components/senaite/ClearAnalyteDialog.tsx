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
import {
  clearAnalyteSlot,
  type ClearAnalytePreview,
  type RemovalImpact,
} from '@/lib/api'

interface ClearAnalyteDialogProps {
  open: boolean
  sampleId: string
  senaiteUid: string
  slot: number
  peptideId: number | null
  peptideName: string
  onClose: () => void
  onCleared: () => void
}

function isPreview(v: unknown): v is ClearAnalytePreview {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { dry_run?: unknown }).dry_run === true
  )
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Clear one analyte slot — the blend has one analyte fewer (KLOW → GLOW
 * dropped KPV; PB-0469, 2026-09-08). Replace can only swap a slot's peptide;
 * typing over the slot produced the same peptide in two slots. This dialog
 * previews the cascade with a dry-run (nothing written), then requires the
 * peptide name typed back before it clears: the SENAITE slot fields are
 * blanked, the parent identity service removed, never-worked vial rows
 * deleted and worked ones rejected. When the peptide still occupies another
 * slot, only the slot fields are blanked — rows and identity belong there.
 */
export function ClearAnalyteDialog({
  open,
  sampleId,
  senaiteUid,
  slot,
  peptideId,
  peptideName,
  onClose,
  onCleared,
}: ClearAnalyteDialogProps) {
  const [preview, setPreview] = useState<ClearAnalytePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setPreview(null)
    setPreviewError(null)
    setTyped('')
    clearAnalyteSlot(sampleId, slot, {
      senaiteUid,
      oldPeptideId: peptideId,
      dryRun: true,
    })
      .then(res => {
        if (cancelled) return
        if (isPreview(res)) setPreview(res)
        else setPreviewError('Unexpected response from the preview call')
      })
      .catch((e: Error) => {
        if (!cancelled) setPreviewError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [open, sampleId, slot, senaiteUid, peptideId])

  const confirmMatches =
    typed.trim().toLowerCase() === peptideName.trim().toLowerCase()
  const impact: RemovalImpact = preview?.impact ?? {
    pristine: [],
    worked_unverified: [],
    blocked: [],
  }
  const canClear =
    preview !== null &&
    confirmMatches &&
    !pending &&
    preview.presubsample_blocked.length === 0

  async function doClear() {
    if (!preview) return
    setPending(true)
    try {
      await clearAnalyteSlot(sampleId, slot, {
        senaiteUid,
        oldPeptideId: peptideId,
        confirm: true,
      })
      toast.success(
        `Slot ${slot} cleared — ${peptideName} removed from the blend`
      )
      onCleared()
      onClose()
    } catch (e) {
      const err = e as Error & { status?: number }
      toast.error('Clear failed', { description: err.message })
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
          <DialogTitle>
            Clear analyte {slot} — {peptideName}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground -mt-1">
          Removes this analyte from the blend. Use Replace instead if a
          different peptide belongs in this slot.
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
              Slot {slot} peptide and declared quantity will be blanked in
              SENAITE.
            </li>
            {preview.cascade ? (
              <>
                {preview.identity_keyword && (
                  <li>
                    Parent identity service{' '}
                    <span className="font-mono">
                      {preview.identity_keyword}
                    </span>{' '}
                    will be removed.
                  </li>
                )}
                <li>
                  {plural(impact.pristine.length, 'never-worked vial row')} will
                  be deleted.
                </li>
                <li>
                  {plural(impact.worked_unverified.length, 'worked result')}{' '}
                  will be rejected.
                </li>
                {impact.blocked.length > 0 && (
                  <li className="text-amber-600 dark:text-amber-400">
                    {plural(impact.blocked.length, 'verified/promoted result')}{' '}
                    will be retracted.
                  </li>
                )}
                {preview.presubsample_blocked.length > 0 && (
                  <li className="text-destructive">
                    Blocked: verified/published SENAITE results on this slot (
                    {preview.presubsample_blocked.join(', ')}). Invalidate or
                    retest in SENAITE first.
                  </li>
                )}
              </>
            ) : (
              <li className="text-muted-foreground">
                {peptideName} is also in another slot — that slot keeps its
                results and identity; only this slot is blanked.
              </li>
            )}
          </ul>
        )}

        <label className="block text-xs text-muted-foreground mt-2">
          Type {peptideName} to confirm
          <input
            type="text"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            disabled={preview === null}
            className="mt-1 w-full px-3 py-2 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            autoComplete="off"
          />
        </label>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={doClear} disabled={!canClear}>
            {pending ? 'Clearing…' : `Clear slot ${slot}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
