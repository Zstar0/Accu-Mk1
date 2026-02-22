import { useState, useEffect, useRef } from 'react'
import {
  Camera,
  Loader2,
  RotateCcw,
  AlertCircle,
  Video,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { processVialPhoto } from './image-processing'

/** Fraction of the video's shorter axis covered by the guide square. */
const GUIDE_RATIO = 0.6

const SS_DEVICE_KEY = 'intake:receive-sample:camera-device'
const SS_ENHANCE_KEY = 'intake:receive-sample:enhance'

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type CameraState =
  | { phase: 'initializing' }
  | { phase: 'error'; message: string }
  | { phase: 'preview' }
  | { phase: 'processing' }
  | { phase: 'review'; dataUrl: string }

interface PhotoCaptureProps {
  /** Previously captured data URL (restored from sessionStorage). */
  capturedUrl: string | null
  /** Called when the operator accepts a processed photo. */
  onCapture: (dataUrl: string) => void
  /** Called when the operator discards the current photo. */
  onClear: () => void
}

export function PhotoCapture({
  capturedUrl,
  onCapture,
  onClear,
}: PhotoCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Camera device selection
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(
    () => sessionStorage.getItem(SS_DEVICE_KEY) ?? ''
  )

  // Post-processing toggle
  const [enhance, setEnhance] = useState(
    () => sessionStorage.getItem(SS_ENHANCE_KEY) !== 'false'
  )

  // Bump this to trigger a camera (re)start via the effect
  const [cameraRequest, setCameraRequest] = useState(() =>
    capturedUrl ? -1 : 0
  )

  const [state, setState] = useState<CameraState>(() =>
    capturedUrl
      ? { phase: 'review', dataUrl: capturedUrl }
      : { phase: 'initializing' }
  )

  // -------------------------------------------------------------------
  // Enumerate video devices
  // -------------------------------------------------------------------

  useEffect(() => {
    async function enumerate() {
      try {
        const all = await navigator.mediaDevices.enumerateDevices()
        const videoDevices = all.filter(d => d.kind === 'videoinput')
        setDevices(videoDevices)
      } catch {
        // Silently fail — device list is optional UX enhancement
      }
    }

    void enumerate()

    // Re-enumerate when devices change (e.g. USB webcam plugged in)
    navigator.mediaDevices.addEventListener('devicechange', enumerate)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', enumerate)
    }
  }, [])

  // Persist selected device to sessionStorage
  useEffect(() => {
    if (selectedDeviceId) {
      sessionStorage.setItem(SS_DEVICE_KEY, selectedDeviceId)
    }
  }, [selectedDeviceId])

  // Persist enhance toggle
  useEffect(() => {
    sessionStorage.setItem(SS_ENHANCE_KEY, String(enhance))
  }, [enhance])

  // -------------------------------------------------------------------
  // Camera lifecycle — driven by `cameraRequest` + `selectedDeviceId`
  // -------------------------------------------------------------------

  useEffect(() => {
    if (cameraRequest < 0) return // -1 means "don't start camera"

    let cancelled = false

    async function init() {
      try {
        const constraints: MediaStreamConstraints = {
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            ...(selectedDeviceId
              ? { deviceId: { exact: selectedDeviceId } }
              : {}),
          },
        }
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop())
          return
        }
        streamRef.current = stream

        // After getting permission, re-enumerate to get device labels
        const all = await navigator.mediaDevices.enumerateDevices()
        const videoDevices = all.filter(d => d.kind === 'videoinput')
        if (!cancelled) {
          setDevices(videoDevices)

          // Auto-select the device we actually got if none was chosen
          if (!selectedDeviceId) {
            const activeTrack = stream.getVideoTracks()[0]
            const activeDeviceId = activeTrack?.getSettings().deviceId
            if (activeDeviceId) {
              setSelectedDeviceId(activeDeviceId)
            }
          }
        }

        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          await video.play()
          if (!cancelled) setState({ phase: 'preview' })
        }
      } catch (err) {
        if (!cancelled) {
          setState({ phase: 'error', message: getUserMediaErrorMessage(err) })
        }
      }
    }

    void init()

    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
  }, [cameraRequest, selectedDeviceId])

  // -------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------

  function handleCapture() {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    setState({ phase: 'processing' })

    // Use requestAnimationFrame to let the UI update before blocking
    requestAnimationFrame(() => {
      try {
        const dataUrl = processVialPhoto(video, canvas, GUIDE_RATIO, enhance)
        // Stop camera tracks
        streamRef.current?.getTracks().forEach(t => t.stop())
        streamRef.current = null
        onCapture(dataUrl)
        setState({ phase: 'review', dataUrl })
      } catch {
        setState({
          phase: 'error',
          message: 'Image processing failed. Please try again.',
        })
      }
    })
  }

  // -------------------------------------------------------------------
  // Retake / Accept
  // -------------------------------------------------------------------

  function handleRetake() {
    onClear()
    setState({ phase: 'initializing' })
    setCameraRequest(prev => prev + 1)
  }

  function handleRetry() {
    setState({ phase: 'initializing' })
    setCameraRequest(prev => prev + 1)
  }

  function handleDeviceChange(deviceId: string) {
    // Stop current stream before switching
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setSelectedDeviceId(deviceId)
    setState({ phase: 'initializing' })
    setCameraRequest(prev => prev + 1)
  }

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------

  const showVideo =
    state.phase === 'initializing' ||
    state.phase === 'preview' ||
    state.phase === 'processing'

  return (
    <div className="flex flex-col items-center gap-6">
      {/* Hidden work canvas */}
      <canvas ref={canvasRef} className="hidden" />

      {/* ---- Initializing spinner (overlays the video container) ---- */}
      {state.phase === 'initializing' && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="text-sm">Starting camera...</p>
        </div>
      )}

      {/* ---- Error ---- */}
      {state.phase === 'error' && (
        <div className="flex flex-col items-center gap-4 w-full max-w-md">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={handleRetry}>
            Try Again
          </Button>
        </div>
      )}

      {/* ---- Camera selector ---- */}
      {state.phase !== 'review' && devices.length > 1 && (
        <div className="flex items-center gap-2 w-full max-w-lg">
          <Video className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Select value={selectedDeviceId} onValueChange={handleDeviceChange}>
            <SelectTrigger className="w-full" size="sm">
              <SelectValue placeholder="Select camera..." />
            </SelectTrigger>
            <SelectContent>
              {devices.map((d, i) => (
                <SelectItem key={d.deviceId} value={d.deviceId}>
                  {d.label || `Camera ${i + 1}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* ---- Post-processing toggle ---- */}
      {state.phase !== 'review' && (
        <label
          htmlFor="enhance-toggle"
          className="flex items-center gap-2 w-full max-w-lg cursor-pointer"
        >
          <Checkbox
            id="enhance-toggle"
            checked={enhance}
            onCheckedChange={v => setEnhance(v === true)}
          />
          <span className="text-sm text-muted-foreground select-none">
            Auto-enhance (levels, contrast, white balance)
          </span>
        </label>
      )}

      {/* ---- Live video (always mounted to preserve stream, hidden when not needed) ---- */}
      <div
        className={
          showVideo
            ? 'flex flex-col items-center gap-4 w-full max-w-lg'
            : 'hidden'
        }
      >
        <div className="relative w-full overflow-hidden rounded-lg bg-black">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="block w-full"
          />

          {/* Guide overlay: darkens outside, shows centered square */}
          {(state.phase === 'preview' || state.phase === 'processing') && (
            <>
              <div
                className="absolute border-2 border-white/80 rounded-sm pointer-events-none"
                style={{
                  width: `${GUIDE_RATIO * 100}%`,
                  aspectRatio: '1',
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -50%)',
                  boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.45)',
                }}
              />

              {/* Corner marks */}
              {(
                [
                  'top-left',
                  'top-right',
                  'bottom-left',
                  'bottom-right',
                ] as const
              ).map(corner => (
                <div
                  key={corner}
                  className="absolute pointer-events-none"
                  style={{
                    width: `${GUIDE_RATIO * 100}%`,
                    aspectRatio: '1',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                  }}
                >
                  <CornerMark position={corner} />
                </div>
              ))}
            </>
          )}

          {/* Processing spinner overlay */}
          {state.phase === 'processing' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60">
              <Loader2 className="h-8 w-8 animate-spin text-white" />
            </div>
          )}
        </div>

        {(state.phase === 'preview' || state.phase === 'processing') && (
          <>
            <p className="text-xs text-muted-foreground">
              Position the vial inside the guide square
            </p>

            <Button
              size="lg"
              onClick={handleCapture}
              disabled={state.phase === 'processing'}
            >
              <Camera className="h-5 w-5" />
              Capture
            </Button>
          </>
        )}
      </div>

      {/* ---- Review ---- */}
      {state.phase === 'review' && (
        <div className="flex flex-col items-center gap-4">
          <div className="rounded-lg border bg-muted/30 p-4">
            <img
              src={state.dataUrl}
              alt="Captured vial photo"
              className="rounded max-w-xs w-full h-auto"
            />
          </div>

          <p className="text-xs text-muted-foreground">
            500 &times; 496 preview &mdash; scales to 125 &times; 124 for COA
          </p>

          <Button variant="outline" onClick={handleRetake}>
            <RotateCcw className="h-4 w-4" />
            Retake
          </Button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Corner marks (L-shaped lines at each corner of the guide square)
// ---------------------------------------------------------------------------

function CornerMark({
  position,
}: {
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
}) {
  const size = 12 // px
  const base = 'absolute bg-white/90'
  const thickness = 2

  const isTop = position.includes('top')
  const isLeft = position.includes('left')

  return (
    <>
      {/* Horizontal bar */}
      <div
        className={base}
        style={{
          width: size,
          height: thickness,
          [isTop ? 'top' : 'bottom']: -1,
          [isLeft ? 'left' : 'right']: -1,
        }}
      />
      {/* Vertical bar */}
      <div
        className={base}
        style={{
          width: thickness,
          height: size,
          [isTop ? 'top' : 'bottom']: -1,
          [isLeft ? 'left' : 'right']: -1,
        }}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

function getUserMediaErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
        return 'Camera access denied. Please allow camera access in your browser or system settings and try again.'
      case 'NotFoundError':
        return 'No camera found. Please connect a webcam and try again.'
      case 'NotReadableError':
      case 'AbortError':
        return 'Camera is in use by another application. Please close it and try again.'
      default:
        return `Could not access camera: ${err.message}`
    }
  }
  return 'Could not access camera. Please try again.'
}
