import { useState, useRef, useEffect, useCallback } from 'react'
import { Camera, CheckCircle2, Crosshair, Printer, RotateCcw, Upload } from 'lucide-react'
import { fetchSubSamplePhotoUrl, type SenaiteLookupResult, type SubSample } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { usePrintLabel } from '@/components/samples/usePrintLabel'
import { PrintLabelPortal } from '@/components/samples/PrintLabelPortal'
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
  // First-vial-of-a-never-received-parent saves to the parent AR (no
  // sub-sample row); subsequent vials become sub-samples. Caller returns the
  // resolved sample_id either way for the confirmation card.
  onSaveNew: (
    photoBytes: Uint8Array,
    remarks?: string,
  ) => Promise<{ sampleId: string }>
  onSaveEdit: (
    sampleId: string,
    photoBytes?: Uint8Array,
    remarks?: string
  ) => Promise<void>
  onDelete: (sampleId: string) => Promise<void>
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
}: Props) {
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null)
  const [remarks, setRemarks] = useState(editingSub?.remarks ?? '')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  // After a successful new-vial save, we show a confirmation card with the
  // returned sample ID until the user clicks "Receive another vial". Edit
  // mode does not use this — editingSub takes precedence below.
  const [savedSampleId, setSavedSampleId] = useState<string | null>(null)
  // Single-label print from the confirmation card. Lets the tech print →
  // label-and-apply → click "Receive another vial" without leaving the panel.
  const { printLabel, target: printTarget } = usePrintLabel()
  // When editing an existing vial, prefer-existing-photo unless the user
  // explicitly clicks Retake. This lets us treat "load existing photo" as
  // captured-equivalent state without forcing a new shot.
  const [editPhotoOverride, setEditPhotoOverride] = useState(false)

  // Crosshair guide for centering the vial in the frame. Persisted across
  // sessions so techs don't have to re-enable it every check-in.
  const [showGuides, setShowGuides] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('wizard-camera-guides') === '1'
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    localStorage.setItem('wizard-camera-guides', showGuides ? '1' : '0')
  }, [showGuides])

  const videoRef = useRef<HTMLVideoElement>(null)
  // Persist the camera stream across renders so we can re-attach it when the
  // <video> element remounts — e.g. after the save-confirmation card returns
  // to live capture, the <video> is a fresh DOM node and needs srcObject set
  // again.
  const streamRef = useRef<MediaStream | null>(null)
  const setVideoRef = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el
    if (el && streamRef.current && el.srcObject !== streamRef.current) {
      el.srcObject = streamRef.current
    }
  }, [])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [cameraOk, setCameraOk] = useState(true)

  // Reset state when switching between create/edit/different vials.
  useEffect(() => {
    setRemarks(editingSub?.remarks ?? '')
    setPhotoDataUrl(null)
    setLocalError(null)
    setEditPhotoOverride(false)
    setSavedSampleId(null)
  }, [editingSub?.sample_id, editingSub?.remarks])

  // When editing a sub-sample with a saved photo, fetch the existing image
  // so the user can see what's on file before deciding to keep or retake.
  // Falls back gracefully if the fetch fails — the form still works.
  const [existingPhotoUrl, setExistingPhotoUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!editingSub?.photo_external_uid) {
      setExistingPhotoUrl(null)
      return
    }
    let cancelled = false
    void fetchSubSamplePhotoUrl(editingSub.sample_id)
      .then(url => {
        if (!cancelled) setExistingPhotoUrl(url)
      })
      .catch(() => {
        if (!cancelled) setExistingPhotoUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [editingSub?.sample_id, editingSub?.photo_external_uid])

  // Initialize camera. Cleanup on unmount. Stream lives in streamRef so the
  // callback ref above can re-attach it whenever the <video> element mounts
  // (e.g. after the save-confirmation card returns to capture mode).
  useEffect(() => {
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
        streamRef.current = s
        if (videoRef.current) {
          videoRef.current.srcObject = s
        }
      })
      .catch(() => setCameraOk(false))
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
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

  const retake = useCallback(() => {
    setPhotoDataUrl(null)
    setLocalError(null)
    // For edit mode: explicitly drop back to live preview to overwrite the
    // existing photo on save.
    if (editingSub) {
      setEditPhotoOverride(true)
    }
  }, [editingSub])

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
        // Edit mode keeps current behavior — no confirmation card.
        // The parent clears editingSampleId; reset effect handles state.
        setPhotoDataUrl(null)
        setRemarks('')
        setEditPhotoOverride(false)
      } else {
        if (!photoBytes) {
          setLocalError('Photo is required.')
          setBusy(false)
          return
        }
        const saved = await onSaveNew(photoBytes, trimmedRemarks)
        // Defense in depth: reset transient state so falling back to the
        // form (e.g. via "Receive another vial") starts clean.
        setPhotoDataUrl(null)
        setRemarks('')
        setSavedSampleId(saved.sampleId)
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

  const startAnotherVial = useCallback(() => {
    setSavedSampleId(null)
    setPhotoDataUrl(null)
    setRemarks('')
    setLocalError(null)
  }, [])

  const error = localError ?? parentError

  // Build the at-a-glance one-liner: "{client} · {peptide} · {qty}".
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

  // Confirmation card after a successful new-vial save. Edit mode never
  // reaches this branch because editingSub takes precedence in the parent's
  // reset logic — but we also gate on !editingSub here as a belt-and-braces.
  if (savedSampleId && !editingSub) {
    return (
      <main className="p-6 flex flex-col gap-4 overflow-y-auto">
        <header className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold">
              New vial for {parentSampleId}
            </h2>
            {oneLiner && (
              <p
                className="text-sm text-muted-foreground truncate"
                title={oneLiner}
              >
                {oneLiner}
              </p>
            )}
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3 rounded-lg border bg-muted/40 px-8 py-10 max-w-md w-full transition-colors">
            <CheckCircle2
              className="w-12 h-12 text-primary"
              aria-hidden="true"
            />
            <div className="flex flex-col items-center gap-1">
              <p className="text-base font-medium">Vial saved</p>
              <p className="text-lg font-mono">{savedSampleId}</p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button type="button" onClick={startAnotherVial} autoFocus>
                <Camera className="w-4 h-4" aria-hidden="true" />
                Receive another vial
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => printLabel({
                  sampleId: savedSampleId,
                  orderNumber: parentDetails?.client_order_number ?? null,
                })}
              >
                <Printer className="w-4 h-4" aria-hidden="true" />
                Print label
              </Button>
            </div>
          </div>
        </div>
        <PrintLabelPortal target={printTarget} />
      </main>
    )
  }

  // Determine camera phase. Captured = either a fresh capture/upload OR an
  // existing photo on the editing sub (when the user hasn't asked to retake).
  const showExistingEditPhoto =
    !!editingSub?.photo_external_uid && !editPhotoOverride && !photoDataUrl
  const cameraPhase: 'live' | 'captured' =
    photoDataUrl || showExistingEditPhoto ? 'captured' : 'live'

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
      </header>

      <section className="flex flex-col gap-2">
        {/* Always-available file picker — lets the operator upload a photo from
            disk whether or not the live camera is available. */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          onChange={onPickFile}
          disabled={busy}
          className="hidden"
        />
        {cameraOk ? (
          <>
            {/* Keep the <video> element mounted with stream attached so we
                can swap back to live mode instantly on retake — no
                getUserMedia round-trip. Hide it via CSS rather than
                unmount. */}
            <div
              className={
                cameraPhase === 'live'
                  ? 'relative block w-full max-w-md'
                  : 'hidden'
              }
            >
              <video
                ref={setVideoRef}
                autoPlay
                playsInline
                muted
                className="block w-full rounded bg-black aspect-[4/3] object-contain transition-opacity"
              />
              {showGuides && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded overflow-hidden"
                >
                  {/* Horizontal centerline */}
                  <div
                    className="absolute left-0 right-0 top-1/2 h-px bg-emerald-400/60 mix-blend-screen"
                  />
                  {/* Vertical centerline */}
                  <div
                    className="absolute top-0 bottom-0 left-1/2 w-px bg-emerald-400/60 mix-blend-screen"
                  />
                  {/* Center crosshair dot for visibility on busy backgrounds */}
                  <div
                    className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full border border-emerald-400/80 mix-blend-screen"
                  />
                </div>
              )}
            </div>
            {cameraPhase === 'captured' && photoDataUrl && (
              <img
                src={photoDataUrl}
                alt="Captured vial"
                className="block w-full max-w-md rounded border aspect-[4/3] object-contain bg-black transition-opacity"
              />
            )}
            {cameraPhase === 'captured' &&
              !photoDataUrl &&
              showExistingEditPhoto && (
                <div className="flex flex-col gap-1 max-w-md">
                  {existingPhotoUrl ? (
                    <img
                      src={existingPhotoUrl}
                      alt={`Existing photo for ${editingSub?.sample_id}`}
                      className="block w-full max-w-md rounded border aspect-[4/3] object-contain bg-black transition-opacity"
                    />
                  ) : (
                    <div className="rounded border bg-muted/40 px-3 py-6 text-sm text-muted-foreground text-center transition-colors">
                      Existing photo on file for {editingSub?.sample_id}.
                    </div>
                  )}
                </div>
              )}
            <canvas ref={canvasRef} className="hidden" />
            <div className="flex flex-wrap items-center gap-2">
              {cameraPhase === 'live' ? (
                <Button type="button" onClick={capture} disabled={busy}>
                  <Camera className="w-4 h-4" aria-hidden="true" />
                  Capture photo
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={retake}
                  disabled={busy}
                >
                  <RotateCcw className="w-4 h-4" aria-hidden="true" />
                  Retake photo
                </Button>
              )}
              {cameraPhase === 'live' && (
                <Button
                  type="button"
                  variant={showGuides ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setShowGuides(v => !v)}
                  disabled={busy}
                  aria-pressed={showGuides}
                  title="Toggle center crosshair guides"
                >
                  <Crosshair className="w-4 h-4" aria-hidden="true" />
                  Guides {showGuides ? 'on' : 'off'}
                </Button>
              )}
              {cameraPhase === 'live' && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                >
                  <Upload className="w-4 h-4" aria-hidden="true" />
                  Choose file...
                </Button>
              )}
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <p className="text-sm">
              Camera unavailable. Upload a photo from disk instead:
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              <Upload className="w-4 h-4" aria-hidden="true" />
              Choose file...
            </Button>
            {photoDataUrl ? (
              <img
                src={photoDataUrl}
                alt="Uploaded vial"
                className="block w-full max-w-md rounded border aspect-[4/3] object-contain bg-black"
              />
            ) : (
              editingSub?.photo_external_uid &&
              !editPhotoOverride &&
              existingPhotoUrl && (
                <img
                  src={existingPhotoUrl}
                  alt={`Existing photo for ${editingSub.sample_id}`}
                  className="block w-full max-w-md rounded border aspect-[4/3] object-contain bg-black"
                />
              )
            )}
          </div>
        )}
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
          className="disabled:opacity-50"
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
