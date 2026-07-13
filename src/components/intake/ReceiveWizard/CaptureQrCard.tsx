import { useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Smartphone } from 'lucide-react'
import { mintCaptureToken, type CaptureSampleContext } from '@/lib/api'

export interface CaptureContext {
  orderLabel: string | null
  samples: CaptureSampleContext[]
}

/**
 * QR the tech scans to add packaging photos from their phone. Mints a
 * scoped 2h capture token on mount; the QR is the only place the raw token
 * ever appears. Mint failure just hides the card — the desktop camera is
 * unaffected and the QR is a pure enhancement.
 */
export function CaptureQrCard({
  captureContext,
}: {
  captureContext: CaptureContext
}) {
  const [url, setUrl] = useState<string | null>(null)
  // Guards mint-once semantics: a parent re-render can pass a new
  // captureContext object identity without meaning "mint again", so the ref
  // (not the dependency list) is what decides whether this effect body runs.
  const mintedRef = useRef(false)
  // Unmount-only guard for the async resolution below. A per-effect-run
  // `cancelled` local would be wrong here: OrderReceiveSession rebuilds
  // captureContext as a fresh object every render, so this effect re-runs
  // (and its cleanup fires) while the ONE real mint call (gated by
  // mintedRef) is still in flight — a per-run flag would discard the
  // resolved token. This ref only flips on true component unmount.
  const unmountedRef = useRef(false)
  useEffect(() => {
    return () => {
      unmountedRef.current = true
    }
  }, [])
  useEffect(() => {
    if (mintedRef.current) return
    mintedRef.current = true
    mintCaptureToken({
      samples: captureContext.samples,
      orderLabel: captureContext.orderLabel,
    })
      .then(res => {
        if (!unmountedRef.current) {
          setUrl(`${window.location.origin}/m/capture.html?t=${res.token}`)
        }
      })
      .catch(() => {
        if (!unmountedRef.current) setUrl(null)
      })
  }, [captureContext])
  if (!url) return null
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3 max-w-md">
      <QRCodeSVG
        value={url}
        size={96}
        className="shrink-0 rounded bg-white p-1"
      />
      <div className="text-sm">
        <p className="font-medium flex items-center gap-1">
          <Smartphone className="w-4 h-4" aria-hidden="true" />
          Scan with your phone to add box photos
        </p>
        <p className="text-muted-foreground text-xs mt-1">
          Photos land on{' '}
          {captureContext.samples.length > 1
            ? `all ${captureContext.samples.length} samples in this order`
            : 'this sample'}{' '}
          within a few seconds. Link expires in 2 hours.
        </p>
      </div>
    </div>
  )
}
