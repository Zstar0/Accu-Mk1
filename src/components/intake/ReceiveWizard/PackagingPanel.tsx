import { useState, useRef, useEffect, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Camera, Crosshair, RotateCcw, Upload } from 'lucide-react'
import { toast } from 'sonner'
import {
  createPackagingPhoto,
  createPackagingPhotosBulk,
  fetchPackagingPhotoUrl,
  updatePackagingPhoto,
  type CaptureSampleContext,
  type PackagingPhoto,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  captureMimeType,
  CAPTURE_JPEG_QUALITY,
  highestSupportedResValue,
  supportedResOptions,
  videoConstraints,
  type CaptureCapabilities,
  type CaptureFormat,
} from './capture-options'
import { useCameraDevices } from './use-camera-devices'

interface PackagingPanelProps {
  parentSampleId: string
  editing?: PackagingPhoto | null
  onSaved?: () => void
  onCancelEdit?: () => void
  // When set (order flow, length > 1), Save fans the same photo out to every
  // sample in the order via the bulk endpoint instead of just parentSampleId.
  // Edit mode never fans out — it always targets the single photo being edited.
  fanoutSampleIds?: string[]
  // Scopes the phone-capture QR (Task 7) to the same sample set Save writes
  // to. Standalone (non-order) ReceiveWizard builds a one-sample context;
  // absent entirely means no QR card renders.
  captureContext?: { orderLabel: string | null; samples: CaptureSampleContext[] }
}

async function dataUrlToBytes(dataUrl: string): Promise<Uint8Array> {
  const resp = await fetch(dataUrl)
  const blob = await resp.blob()
  const buf = await blob.arrayBuffer()
  return new Uint8Array(buf)
}

// Lifted from useReceiveWizard — the API client takes base64, so we chunk the
// bytes to stay under btoa's argument limits.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk) as unknown as number[],
    )
  }
  return btoa(binary)
}

export function PackagingPanel({
  parentSampleId,
  editing,
  onSaved,
  onCancelEdit,
  fanoutSampleIds,
}: PackagingPanelProps) {
  const queryClient = useQueryClient()
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null)
  const [remarks, setRemarks] = useState(editing?.remarks ?? '')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  // When editing an existing photo, prefer the existing image unless the user
  // explicitly clicks Retake — lets a remarks-only edit skip re-uploading.
  const [editPhotoOverride, setEditPhotoOverride] = useState(false)

  // Crosshair guide for centering the item in the frame. Persisted across
  // sessions so techs don't have to re-enable it every check-in.
  const [showGuides, setShowGuides] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('wizard-camera-guides') === '1'
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    localStorage.setItem('wizard-camera-guides', showGuides ? '1' : '0')
  }, [showGuides])

  // Capture resolution (experiment chooser). Persisted so a chosen setting
  // sticks across check-ins. `actualRes` shows what the camera negotiated.
  const [captureRes, setCaptureRes] = useState<string>(() => {
    if (typeof window === 'undefined') return '1280x720'
    return localStorage.getItem('wizard-capture-res') || '1280x720'
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    localStorage.setItem('wizard-capture-res', captureRes)
  }, [captureRes])
  const [actualRes, setActualRes] = useState<string | null>(null)
  const [captureCaps, setCaptureCaps] = useState<CaptureCapabilities | null>(null)

  // Capture format (experiment toggle). JPEG default — ~10× smaller than PNG
  // and web-native; PNG kept for lossless captures.
  const [captureFormat, setCaptureFormat] = useState<CaptureFormat>(() => {
    if (typeof window === 'undefined') return 'jpeg'
    return localStorage.getItem('wizard-capture-format') === 'png' ? 'png' : 'jpeg'
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    localStorage.setItem('wizard-capture-format', captureFormat)
  }, [captureFormat])

  // Drop any saved resolution the camera can't reach back to its best preset.
  useEffect(() => {
    if (!captureCaps) return
    const opts = supportedResOptions(captureCaps)
    if (!opts.some(o => o.value === captureRes)) {
      const best = highestSupportedResValue(captureCaps)
      if (best) setCaptureRes(best)
    }
  }, [captureCaps, captureRes])

  const resOptions = supportedResOptions(captureCaps)

  const videoRef = useRef<HTMLVideoElement>(null)
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

  // Camera device list + persisted selection ('' = browser default). The
  // active id mirrors whichever device the unpinned stream landed on, so the
  // dropdown shows the truth even before an explicit choice.
  const { devices, selectedDeviceId, setSelectedDeviceId, refreshDevices } =
    useCameraDevices()
  const [activeDeviceId, setActiveDeviceId] = useState('')

  // Reset state when switching between create/edit/different photos.
  useEffect(() => {
    setRemarks(editing?.remarks ?? '')
    setPhotoDataUrl(null)
    setLocalError(null)
    setEditPhotoOverride(false)
  }, [editing?.id, editing?.remarks])

  // When editing, fetch the existing image so the tech can see what's on file
  // before deciding to keep or retake. Falls back gracefully on fetch failure.
  const [existingPhotoUrl, setExistingPhotoUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!editing) {
      setExistingPhotoUrl(null)
      return
    }
    let cancelled = false
    void fetchPackagingPhotoUrl(editing.id)
      .then(url => {
        if (!cancelled) setExistingPhotoUrl(url)
      })
      .catch(() => {
        if (!cancelled) setExistingPhotoUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [editing?.id])

  // Initialize camera. Cleanup on unmount. Stream lives in streamRef so the
  // callback ref can re-attach it whenever the <video> element mounts.
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
      .getUserMedia({ video: videoConstraints(captureRes, selectedDeviceId) })
      .then(s => {
        if (cancelled) {
          s.getTracks().forEach(t => t.stop())
          return
        }
        streamRef.current = s
        const track = s.getVideoTracks?.()[0]
        if (track?.getCapabilities) {
          try {
            const caps = track.getCapabilities()
            setCaptureCaps({ width: caps.width, height: caps.height })
          } catch {
            // capabilities unsupported on this browser — keep the full list
          }
        }
        setActiveDeviceId(track?.getSettings?.().deviceId ?? '')
        // Labels are blank until a permission grant — re-list now that we
        // have one, so the Camera dropdown shows real device names.
        refreshDevices()
        if (videoRef.current) {
          videoRef.current.srcObject = s
        }
      })
      .catch(() => {
        if (cancelled) return
        if (selectedDeviceId) {
          // Saved camera is gone (unplugged / id rotated) — drop the pin so
          // the effect retries with the default camera instead of going dark.
          setSelectedDeviceId('')
        } else {
          setCameraOk(false)
        }
      })
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
  }, [captureRes, selectedDeviceId, setSelectedDeviceId, refreshDevices])

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
    setPhotoDataUrl(c.toDataURL(captureMimeType(captureFormat), CAPTURE_JPEG_QUALITY))
    setLocalError(null)
  }, [captureFormat])

  const retake = useCallback(() => {
    setPhotoDataUrl(null)
    setLocalError(null)
    if (editing) {
      setEditPhotoOverride(true)
    }
  }, [editing])

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
      const photoBase64 = photoDataUrl
        ? bytesToBase64(await dataUrlToBytes(photoDataUrl))
        : undefined
      const trimmed = remarks.trim()
      const trimmedRemarks = trimmed ? trimmed : undefined
      if (editing) {
        // Remarks-only edits are allowed — photoBase64 stays undefined when the
        // tech keeps the existing photo.
        await updatePackagingPhoto(editing.id, {
          photoBase64,
          remarks: trimmedRemarks ?? null,
        })
        if (photoBase64) {
          // A retake keeps the photo id, so the list refetch alone leaves the
          // stale bytes on screen — drop every thumbnail query for this id.
          void queryClient.invalidateQueries({
            queryKey: ['packaging-photo-bytes', editing.id],
          })
        }
      } else {
        if (!photoBase64) {
          setLocalError('Photo is required.')
          setBusy(false)
          return
        }
        if (fanoutSampleIds && fanoutSampleIds.length > 1) {
          await createPackagingPhotosBulk({
            parentSampleIds: fanoutSampleIds,
            photoBase64,
            remarks: trimmedRemarks ?? null,
          })
          for (const id of fanoutSampleIds) {
            void queryClient.invalidateQueries({
              queryKey: ['packaging-photos', id],
            })
          }
          toast(`Photo added to ${fanoutSampleIds.length} samples`)
        } else {
          await createPackagingPhoto({
            parentSampleId,
            photoBase64,
            remarks: trimmedRemarks ?? null,
          })
        }
      }
      void queryClient.invalidateQueries({
        queryKey: ['packaging-photos', parentSampleId],
      })
      setPhotoDataUrl(null)
      setRemarks('')
      setEditPhotoOverride(false)
      onSaved?.()
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [photoDataUrl, remarks, editing, parentSampleId, fanoutSampleIds, queryClient, onSaved])

  const error = localError

  // Captured = a fresh capture/upload OR an existing photo on the editing row
  // (when the user hasn't asked to retake).
  const showExistingEditPhoto = !!editing && !editPhotoOverride && !photoDataUrl
  const cameraPhase: 'live' | 'captured' =
    photoDataUrl || showExistingEditPhoto ? 'captured' : 'live'

  return (
    <main className="p-6 flex flex-col gap-4 overflow-y-auto">
      <header className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold">
            {editing
              ? 'Edit packaging photo'
              : `New packaging photo for ${parentSampleId}`}
          </h2>
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
                onLoadedMetadata={e =>
                  setActualRes(
                    `${e.currentTarget.videoWidth}×${e.currentTarget.videoHeight}`,
                  )
                }
                className="block w-full rounded bg-black aspect-[4/3] object-contain transition-opacity"
              />
              {showGuides && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded overflow-hidden"
                >
                  <div className="absolute left-0 right-0 top-1/2 h-px bg-emerald-400/60 mix-blend-screen" />
                  <div className="absolute top-0 bottom-0 left-1/2 w-px bg-emerald-400/60 mix-blend-screen" />
                  <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full border border-emerald-400/80 mix-blend-screen" />
                </div>
              )}
            </div>
            {cameraPhase === 'captured' && photoDataUrl && (
              <img
                src={photoDataUrl}
                alt="Captured packaging"
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
                      alt="Existing packaging photo"
                      className="block w-full max-w-md rounded border aspect-[4/3] object-contain bg-black transition-opacity"
                    />
                  ) : (
                    <div className="rounded border bg-muted/40 px-3 py-6 text-sm text-muted-foreground text-center transition-colors">
                      Existing photo on file.
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
              {cameraPhase === 'live' && devices.length > 1 && (
                <label className="flex items-center gap-1 text-sm">
                  <span className="text-muted-foreground">Camera</span>
                  <select
                    value={selectedDeviceId || activeDeviceId}
                    onChange={e => setSelectedDeviceId(e.target.value)}
                    disabled={busy}
                    title="Capture camera — pick which webcam feeds the preview"
                    aria-label="Capture camera"
                    className="h-9 rounded-md border bg-background px-2 text-sm disabled:opacity-50"
                  >
                    {devices.map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Camera ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {cameraPhase === 'live' && (
                <label className="flex items-center gap-1 text-sm">
                  <span className="text-muted-foreground">Res</span>
                  <select
                    value={captureRes}
                    onChange={e => setCaptureRes(e.target.value)}
                    disabled={busy}
                    title="Capture resolution (experiment) — falls back if the camera can't reach it"
                    aria-label="Capture resolution"
                    className="h-9 rounded-md border bg-background px-2 text-sm disabled:opacity-50"
                  >
                    {resOptions.map(o => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {actualRes && (
                    <span className="text-xs text-muted-foreground">
                      actual {actualRes}
                    </span>
                  )}
                </label>
              )}
              {cameraPhase === 'live' && (
                <label className="flex items-center gap-1 text-sm">
                  <span className="text-muted-foreground">Format</span>
                  <select
                    value={captureFormat}
                    onChange={e => setCaptureFormat(e.target.value as CaptureFormat)}
                    disabled={busy}
                    title="Capture image format — JPEG is smaller, PNG is lossless"
                    aria-label="Capture image format"
                    className="h-9 rounded-md border bg-background px-2 text-sm disabled:opacity-50"
                  >
                    <option value="jpeg">JPEG</option>
                    <option value="png">PNG</option>
                  </select>
                </label>
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
                alt="Uploaded packaging"
                className="block w-full max-w-md rounded border aspect-[4/3] object-contain bg-black"
              />
            ) : (
              editing &&
              !editPhotoOverride &&
              existingPhotoUrl && (
                <img
                  src={existingPhotoUrl}
                  alt="Existing packaging photo"
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
          placeholder="Anything noteworthy about this packaging..."
        />
      </label>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="flex flex-wrap items-end gap-2">
        <Button
          type="button"
          onClick={handleSave}
          disabled={busy}
          className="disabled:opacity-50"
        >
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Save packaging photo'}
        </Button>
        {editing && (
          <Button
            type="button"
            variant="outline"
            onClick={() => onCancelEdit?.()}
            disabled={busy}
          >
            Cancel
          </Button>
        )}
      </div>
    </main>
  )
}
