import { useEffect, useState } from 'react'
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
export function CaptureQrCard({ captureContext }: { captureContext: CaptureContext }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    mintCaptureToken({
      samples: captureContext.samples,
      orderLabel: captureContext.orderLabel,
    })
      .then(res => {
        if (!cancelled) {
          setUrl(`${window.location.origin}/m/capture.html?t=${res.token}`)
        }
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
    // context is stable for the life of the packaging tab; remount = new token
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!url) return null
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3 max-w-md">
      <QRCodeSVG value={url} size={96} className="shrink-0 rounded bg-white p-1" />
      <div className="text-sm">
        <p className="font-medium flex items-center gap-1">
          <Smartphone className="w-4 h-4" aria-hidden="true" />
          Scan with your phone to add box photos
        </p>
        <p className="text-muted-foreground text-xs mt-1">
          Photos land on {captureContext.samples.length > 1
            ? `all ${captureContext.samples.length} samples in this order`
            : 'this sample'} within a few seconds. Link expires in 2 hours.
        </p>
      </div>
    </div>
  )
}
