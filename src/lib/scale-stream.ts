import { useState, useEffect, useCallback, useRef } from 'react'
import { getApiBaseUrl } from '@/lib/config'
import { getAuthToken } from '@/store/auth-store'

export interface ScaleReading {
  value: number
  unit: string
  stable: boolean
}

export interface ScaleStreamState {
  reading: ScaleReading | null
  error: string | null
  streaming: boolean
  stableCount: number
  isStable: boolean
}

export const STABILITY_THRESHOLD = 5
export const STABILITY_TOLERANCE_MG = 0.5

const initialState: ScaleStreamState = {
  reading: null,
  error: null,
  streaming: false,
  stableCount: 0,
  isStable: false,
}

export function useScaleStream(active: boolean): ScaleStreamState & { stop: () => void } {
  const [state, setState] = useState<ScaleStreamState>(initialState)
  const abortRef = useRef<AbortController | null>(null)
  const windowRef = useRef<number[]>([])

  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    setState(prev => ({ ...prev, streaming: false }))
  }, [])

  useEffect(() => {
    if (!active) {
      stop()
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    windowRef.current = []

    setState(prev => ({ ...prev, streaming: true, error: null }))

    async function run() {
      try {
        const token = getAuthToken()
        const response = await fetch(`${getApiBaseUrl()}/scale/weight/stream`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        const reader = response.body?.getReader()
        if (!reader) throw new Error('No response body')

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          let eventType = ''
          let eventData = ''

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6)
            } else if (line === '' && eventType && eventData) {
              try {
                const payload = JSON.parse(eventData) as Record<string, unknown>

                if (eventType === 'weight') {
                  const value = payload.value as number

                  // Rolling window — keep last STABILITY_THRESHOLD readings
                  const win = windowRef.current
                  win.push(value)
                  if (win.length > STABILITY_THRESHOLD) {
                    win.shift()
                  }

                  const isStable =
                    win.length >= STABILITY_THRESHOLD &&
                    Math.max(...win) - Math.min(...win) <= STABILITY_TOLERANCE_MG

                  setState({
                    reading: {
                      value,
                      unit: payload.unit as string,
                      stable: payload.stable as boolean,
                    },
                    error: null,
                    streaming: true,
                    stableCount: isStable ? STABILITY_THRESHOLD : 0,
                    isStable,
                  })
                } else if (eventType === 'error') {
                  setState(prev => ({
                    ...prev,
                    error: payload.message as string,
                  }))
                }
              } catch {
                // Skip malformed events
              }

              eventType = ''
              eventData = ''
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setState(prev => ({
            ...prev,
            error: err instanceof Error ? err.message : 'Scale stream failed',
          }))
        }
      } finally {
        setState(prev => ({ ...prev, streaming: false }))
      }
    }

    run()

    return () => {
      controller.abort()
    }
  }, [active, stop])

  return { ...state, stop }
}
