import { useState, useRef, useEffect, useCallback } from 'react'
import type { SenaiteLookupResult, SubSample } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

interface Props {
  parentSampleId: string
  parentDetails: SenaiteLookupResult | null
  editingSub: SubSample | null
  loading: boolean
  error: string | null
  onSaveNew: (photoBytes: Uint8Array, remarks?: string) => Promise<void>
  onSaveEdit: (
    sampleId: string,
    photoBytes?: Uint8Array,
    remarks?: string
  ) => Promise<void>
  onDelete: (sampleId: string) => Promise<void>
  onDone: () => void
}

async function dataUrlToBytes(dataUrl: string): Promise<Uint8Array> {
  const resp = await fetch(dataUrl)
  const blob = await resp.blob()
  const buf = await blob.arrayBuffer()
  return new Uint8Array(buf)
}

export function VialPanel({
  parentSampleId,
  parentDetails,
  editingSub,
  loading: parentLoading,
  error: parentError,
  onSaveNew,
  onSaveEdit,
  onDelete,
  onDone,
}: Props) {
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null)
  const [remarks, setRemarks] = useState(editingSub?.remarks ?? '')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [cameraOk, setCameraOk] = useState(true)

  // Reset state when switching between create/edit/different vials.
  useEffect(() => {
    setRemarks(editingSub?.remarks ?? '')
    setPhotoDataUrl(null)
    setLocalError(null)
  }, [editingSub?.sample_id, editingSub?.remarks])

  // Initialize camera. Cleanup on unmount.
  useEffect(() => {
    let stream: MediaStream | null = null
    let cancelled = false
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setCameraOk(false)
      return
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then(s => {
        if (cancelled) {
          s.getTracks().forEach(t => t.stop())
          return
        }
        stream = s
        if (videoRef.current) {
          videoRef.current.srcObject = s
        }
      })
      .catch(() => setCameraOk(false))
    return () => {
      cancelled = true
      stream?.getTracks().forEach(t => t.stop())
    }
  }, [])

  const capture = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return
    const v = videoRef.current
    const c = canvasRef.current
    if (!v.videoWidth) {
      setLocalError('Camera not ready yet — try again in a moment.')
      return
    }
    c.width = v.videoWidth
    c.height = v.videoHeight
    const ctx = c.getContext('2d')
    if (!ctx) {
      setLocalError('Cannot capture — browser canvas unavailable.')
      return
    }
    ctx.drawImage(v, 0, 0)
    setPhotoDataUrl(c.toDataURL('image/jpeg', 0.85))
    setLocalError(null)
  }, [])

  const onPickFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') {
        setPhotoDataUrl(result)
        setLocalError(null)
      }
    }
    reader.readAsDataURL(f)
  }, [])

  const handleSave = useCallback(async () => {
    setBusy(true)
    setLocalError(null)
    try {
      const photoBytes = photoDataUrl
        ? await dataUrlToBytes(photoDataUrl)
        : undefined
      const trimmed = remarks.trim()
      const trimmedRemarks = trimmed ? trimmed : undefined
      if (editingSub) {
        await onSaveEdit(editingSub.sample_id, photoBytes, trimmedRemarks)
      } else {
        if (!photoBytes) {
          setLocalError('Photo is required.')
          setBusy(false)
          return
        }
        await onSaveNew(photoBytes, trimmedRemarks)
      }
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [photoDataUrl, remarks, editingSub, onSaveNew, onSaveEdit])

  const handleDelete = useCallback(async () => {
    if (!editingSub) return
    setConfirmDeleteOpen(false)
    setBusy(true)
    setLocalError(null)
    try {
      await onDelete(editingSub.sample_id)
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [editingSub, onDelete])

  const error = localError ?? parentError

  // Build the at-a-glance one-liner: "{client} · {peptide} · {qty}".
  // We pick the matched peptide name from analyte slot 1 if available, else
  // its raw name, so the tech sees the canonical compound rather than
  // SENAITE's free-text label.
  const oneLinerParts: string[] = []
  if (parentDetails?.client) oneLinerParts.push(parentDetails.client)
  const firstAnalyte = parentDetails?.analytes?.[0]
  if (firstAnalyte) {
    oneLinerParts.push(
      firstAnalyte.matched_peptide_name ?? firstAnalyte.raw_name
    )
  }
  if (parentDetails?.declared_weight_mg != null) {
    oneLinerParts.push(`${parentDetails.declared_weight_mg} mg`)
  }
  const oneLiner = oneLinerParts.join(' · ')

  return (
    <main className="p-6 flex flex-col gap-4 overflow-y-auto">
      <header className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold">
            {editingSub
              ? `Editing ${editingSub.sample_id}`
              : `New vial for ${parentSampleId}`}
          </h2>
          {oneLiner && !editingSub && (
            <p
              className="text-sm text-muted-foreground truncate"
              title={oneLiner}
            >
              {oneLiner}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={onDone}
          disabled={busy}
        >
          Done — print labels
        </Button>
      </header>

      <section className="flex flex-col gap-2">
        {cameraOk ? (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full max-w-md rounded bg-black aspect-[4/3] object-contain"
            />
            <canvas ref={canvasRef} className="hidden" />
            <div>
              <Button type="button" onClick={capture} disabled={busy}>
                Capture photo
              </Button>
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <p className="text-sm">
              Camera unavailable. Upload a photo from disk instead:
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={onPickFile}
              disabled={busy}
              className="text-sm"
            />
          </div>
        )}

        {/* Live preview — captured / uploaded photo, OR an existing-photo notice when editing. */}
        {photoDataUrl ? (
          <img
            src={photoDataUrl}
            alt="Captured vial"
            className="max-w-md rounded border"
          />
        ) : editingSub?.photo_external_uid ? (
          <div className="text-xs text-muted-foreground">
            Existing photo on file. Capture or upload a new one to replace it.
          </div>
        ) : null}
      </section>

      <label className="block">
        <span className="block text-sm font-medium mb-1">
          Remarks (optional)
        </span>
        <Textarea
          value={remarks}
          onChange={e => setRemarks(e.target.value)}
          disabled={busy}
          rows={3}
          className="max-w-md"
          placeholder="Anything noteworthy about this vial..."
        />
      </label>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="flex gap-2">
        <Button
          type="button"
          onClick={handleSave}
          disabled={busy || parentLoading}
        >
          {busy ? 'Saving…' : editingSub ? 'Save changes' : 'Save vial'}
        </Button>
        {editingSub && (
          <>
            <Button
              type="button"
              variant="destructive"
              onClick={() => setConfirmDeleteOpen(true)}
              disabled={busy}
            >
              Delete vial
            </Button>
            <AlertDialog
              open={confirmDeleteOpen}
              onOpenChange={setConfirmDeleteOpen}
            >
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this vial?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Vial {editingSub.sample_id} will be removed. This cannot be
                    undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete}>
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </div>
    </main>
  )
}
