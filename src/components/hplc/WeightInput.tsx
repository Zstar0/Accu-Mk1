import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { getApiBaseUrl } from '@/lib/config'
import { getAuthToken } from '@/store/auth-store'
import { useScaleStream } from '@/lib/scale-stream'

export interface WeightInputProps {
  /** Measurement step key, e.g. "stock_vial_empty_mg" */
  stepKey: string
  /** Human-readable label shown above the input */
  label: string
  /** Called when the tech accepts a weight reading */
  onAccept: (value: number, source: 'scale' | 'manual') => void
}

type ScaleMode = 'loading' | 'scale' | 'manual'

export function WeightInput({ stepKey: _stepKey, label, onAccept }: WeightInputProps) {
  const [scaleMode, setScaleMode] = useState<ScaleMode>('loading')
  const [streamActive, setStreamActive] = useState(false)
  const [manualValue, setManualValue] = useState('')

  // Determine scale vs manual mode on mount
  useEffect(() => {
    let cancelled = false

    async function checkScaleStatus() {
      try {
        const token = getAuthToken()
        const response = await fetch(`${getApiBaseUrl()}/scale/status`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (cancelled) return

        if (!response.ok) {
          setScaleMode('manual')
          return
        }

        const data = (await response.json()) as { status: string }
        if (cancelled) return

        setScaleMode(data.status === 'disabled' ? 'manual' : 'scale')
      } catch {
        if (!cancelled) setScaleMode('manual')
      }
    }

    checkScaleStatus()

    return () => {
      cancelled = true
    }
  }, [])

  const { reading, isStable, error, streaming, stop } = useScaleStream(streamActive)

  function handleAcceptScale() {
    if (!reading) return
    stop()
    setStreamActive(false)
    onAccept(reading.value, 'scale')
  }

  function handleCancelStream() {
    stop()
    setStreamActive(false)
  }

  function handleAcceptManual(valueStr: string) {
    const parsed = parseFloat(valueStr)
    if (!isNaN(parsed)) {
      onAccept(parsed, 'manual')
    }
  }

  // Loading skeleton
  if (scaleMode === 'loading') {
    return <Skeleton className="h-24 w-full" />
  }

  // Manual-only mode
  if (scaleMode === 'manual') {
    const parsed = parseFloat(manualValue)
    const isValid = manualValue.trim() !== '' && !isNaN(parsed)

    return (
      <div className="flex flex-col gap-2">
        <Label htmlFor={`manual-input-${label}`}>{label}</Label>
        <div className="flex gap-2">
          <Input
            id={`manual-input-${label}`}
            type="number"
            step="0.01"
            placeholder="0.00"
            value={manualValue}
            onChange={e => setManualValue(e.target.value)}
          />
          <Button
            onClick={() => handleAcceptManual(manualValue)}
            disabled={!isValid}
          >
            Accept
          </Button>
        </div>
      </div>
    )
  }

  // Scale mode
  const scaleManualParsed = parseFloat(manualValue)
  const scaleManualValid = manualValue.trim() !== '' && !isNaN(scaleManualParsed)

  return (
    <div className="flex flex-col gap-3">
      <Label>{label}</Label>

      {/* Error banner */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error} — scale reconnecting...</AlertDescription>
        </Alert>
      )}

      {!streaming ? (
        <Button onClick={() => setStreamActive(true)}>Read Weight</Button>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Live weight display */}
          <div
            className={[
              'rounded-md border p-4 font-mono text-2xl transition-colors',
              isStable
                ? 'border-green-500 bg-green-50 dark:bg-green-950/20 text-green-700 dark:text-green-400'
                : 'border-border',
            ].join(' ')}
          >
            {reading != null
              ? `${reading.value.toFixed(2)} ${reading.unit}`
              : '—'}
          </div>

          {/* Stability badge */}
          {isStable && (
            <Badge
              variant="outline"
              className="w-fit border-green-500 text-green-700 dark:text-green-400"
            >
              Stable
            </Badge>
          )}

          {/* Action buttons */}
          <div className="flex gap-2">
            <Button
              onClick={handleAcceptScale}
              disabled={!isStable || reading == null}
            >
              Accept Weight
            </Button>
            <Button variant="outline" onClick={handleCancelStream}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Manual escape hatch — always available in scale mode */}
      <details className="mt-1">
        <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
          Enter manually instead
        </summary>
        <div className="mt-2 flex gap-2">
          <Input
            type="number"
            step="0.01"
            placeholder="0.00"
            value={manualValue}
            onChange={e => setManualValue(e.target.value)}
          />
          <Button
            variant="outline"
            disabled={!scaleManualValid}
            onClick={() => {
              setStreamActive(false)
              handleAcceptManual(manualValue)
            }}
          >
            Accept
          </Button>
        </div>
      </details>
    </div>
  )
}
