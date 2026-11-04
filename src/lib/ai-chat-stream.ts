/**
 * AI chat SSE client: one stream per user, for all of that user's chats.
 *
 * The `flag-stream.ts` fetch-reader shape (native `EventSource` cannot send the
 * bearer header), with three differences:
 *   - The URL is `${getApiBaseUrl()}/ai-chat/stream`. The ai-chat router has no
 *     `/api` prefix of its own, so do not copy the flags stream's `/api/flags/...`.
 *   - Resume is server side. `Last-Event-ID` is the last accepted `seq`; the hub
 *     replays what it still holds, or answers `resync` when it cannot.
 *   - A 401 or 403 ends the loop: retrying cannot fix a bad token or a role the
 *     user lost. Any other failure backs off from 250 ms to 30 s.
 *
 * Frames, tokens and payloads are never logged. Writes go through REST.
 */

import { useEffect, useRef } from 'react'
import type { AiChatEvent } from '@/lib/ai-chat-api'
import { getApiBaseUrl } from '@/lib/config'
import { parseFrames } from '@/lib/flag-stream'
import { getAuthToken } from '@/store/auth-store'

/**
 * True when `e` is news for a client that has seen up to `lastSeq`. `resync`
 * always passes: the hub stamps it with its newest seq, which is below the
 * client's id if the server clock stepped back, and dropping it would stall
 * the client with no sign.
 */
export function acceptEvent(lastSeq: number | null, e: AiChatEvent): boolean {
  return e.type === 'resync' || lastSeq === null || e.seq > lastSeq
}

const BACKOFF_BASE_MS = 250
const BACKOFF_CAP_MS = 30_000

/**
 * Subscribe while `enabled`; `false` aborts the connection. Mount once at app
 * scope. `onEvent` gets each accepted event in order.
 *
 * `onConnected` fires once per connection, on the first chunk read and before
 * it is parsed. The response headers prove nothing: they can arrive before the
 * server's generator has subscribed, and the first frame (`: connected`) goes
 * out after it has. A caller that must not miss events published between its
 * own fetch and the subscription (a page load has no `Last-Event-ID`) fetches
 * from this callback.
 *
 * Both callbacks are read through refs, so the subscription does not
 * re-establish when their identity changes; only `enabled` restarts it.
 */
export function useAiChatStream(
  enabled: boolean,
  onEvent: (e: AiChatEvent) => void,
  onConnected?: () => void
): void {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const onConnectedRef = useRef(onConnected)
  onConnectedRef.current = onConnected

  useEffect(() => {
    if (!enabled) return

    const controller = new AbortController()
    // Survives reconnects, starts empty on every restart of the effect.
    let lastSeq: number | null = null
    let attempt = 0
    let stopped = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleReconnect = () => {
      if (stopped) return
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS)
      attempt += 1
      reconnectTimer = setTimeout(connect, delay)
    }

    async function connect() {
      if (stopped) return
      try {
        const headers: Record<string, string> = {}
        const token = getAuthToken()
        if (token) headers['Authorization'] = `Bearer ${token}`
        if (lastSeq !== null) headers['Last-Event-ID'] = String(lastSeq)

        const response = await fetch(`${getApiBaseUrl()}/ai-chat/stream`, {
          headers,
          signal: controller.signal,
        })
        if (response.status === 401 || response.status === 403) {
          stopped = true
          return
        }
        if (!response.ok || !response.body) {
          throw new Error(`ai-chat stream HTTP ${response.status}`)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let connected = false

        while (true) {
          const { done, value } = await reader.read()
          if (done || stopped) break
          if (!connected) {
            connected = true
            attempt = 0 // bytes arrived: reset backoff
            onConnectedRef.current?.()
          }
          buffer += decoder.decode(value, { stream: true })
          const { events, rest } = parseFrames<AiChatEvent>(buffer)
          buffer = rest
          for (const e of events) {
            if (!acceptEvent(lastSeq, e)) continue
            lastSeq = e.seq
            onEventRef.current(e)
          }
        }
        // Clean end-of-stream: reconnect (the server may cycle connections).
        scheduleReconnect()
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        scheduleReconnect()
      }
    }

    connect()

    return () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      controller.abort()
    }
  }, [enabled])
}
