/**
 * Flag System SSE client.
 *
 * Adapts the `scale-stream.ts` fetch-reader pattern (NOT native `EventSource`,
 * which can't send the bearer header). Consumes the Plan-2 wire contract at
 * `GET /api/flags/stream` exactly:
 *   - frames: optional `id: <n>`, `event: <type>`, `data: <json>`, blank-line
 *     terminated; `:`-comment lines are heartbeats and are ignored.
 *   - de-dupe by `event_id` (the server may replay on reconnect).
 *   - reconnect with `Last-Event-ID` + exponential backoff (250ms → cap 30s).
 *
 * Writes always go through REST — this stream is read-only.
 */

import { useEffect, useRef } from 'react'
import { getApiBaseUrl } from '@/lib/config'
import { getAuthToken } from '@/store/auth-store'

/** Event types the server can emit (LOCKED contract). */
export type FlagEventType =
  | 'raised'
  | 'assigned'
  | 'unassigned'
  | 'commented'
  | 'status_changed'
  | 'watcher_added'
  | 'watcher_removed'
  | 'comment_reaction'

/** Post-mutation flag snapshot embedded in every event — enough to render a
 *  toast / update a card without a refetch. */
export interface FlagSnapshot {
  id: number
  title: string
  type: string
  kind: string
  status: string
  entity_type: string
  entity_id: string
  assignee_id: number | null
  created_by: number
}

/** One parsed SSE event `data` payload. */
export interface FlagStreamEvent {
  event_type: FlagEventType | string
  flag_id: number
  actor_id: number | null
  from_value: string | null
  to_value: string | null
  details: Record<string, unknown> | null
  event_id: number
  flag: FlagSnapshot
  /** Reaction events (spec §6) carry these; other event types omit them. */
  comment_id?: number
  emoji?: string
  action?: 'added' | 'removed'
}

/**
 * Pure frame parser. Splits a decoded buffer on the SSE event boundary
 * (`\n\n`), parses every COMPLETE frame, and returns the trailing partial as
 * `rest` to be prepended to the next chunk. Comment/heartbeat frames (only
 * `:`-lines) and frames without a `data:` line yield nothing.
 */
export function parseFrames(buffer: string): {
  events: FlagStreamEvent[]
  rest: string
} {
  const segments = buffer.split('\n\n')
  // The final segment is the (possibly incomplete) leftover — carry it forward.
  const rest = segments.pop() ?? ''
  const events: FlagStreamEvent[] = []
  for (const seg of segments) {
    const parsed = parseFrame(seg)
    if (parsed) events.push(parsed)
  }
  return { events, rest }
}

function parseFrame(segment: string): FlagStreamEvent | null {
  const dataLines: string[] = []
  for (const raw of segment.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line || line.startsWith(':')) continue // blank or heartbeat comment
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    // `id:` / `event:` lines are redundant with the JSON body; we read the JSON.
  }
  if (dataLines.length === 0) return null
  try {
    return JSON.parse(dataLines.join('\n')) as FlagStreamEvent
  } catch {
    return null // malformed — skip rather than tear down the stream
  }
}

/**
 * Filter out events already seen (by `event_id`), mutating `seen` to record the
 * new ones. The server may replay frames after a `Last-Event-ID` reconnect.
 */
export function filterNewEvents(
  events: FlagStreamEvent[],
  seen: Set<number>
): FlagStreamEvent[] {
  const out: FlagStreamEvent[] = []
  for (const e of events) {
    if (e.event_id != null && seen.has(e.event_id)) continue
    if (e.event_id != null) seen.add(e.event_id)
    out.push(e)
  }
  return out
}

const BACKOFF_BASE_MS = 250
const BACKOFF_CAP_MS = 30_000
// Bound the de-dupe set so a long-lived session can't grow it without limit.
const SEEN_CAP = 2_000

/**
 * Subscribe to the flag event stream for the lifetime of the calling component.
 * Mount once at app scope. `onEvent` is invoked for each NEW (deduped) event;
 * the latest closure is always used, so the subscription never re-establishes
 * when `onEvent` changes identity.
 */
export function useFlagStream(onEvent: (e: FlagStreamEvent) => void): void {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    const controller = new AbortController()
    const seen = new Set<number>()
    let lastEventId: string | null = null
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
        const token = getAuthToken()
        const headers: Record<string, string> = {}
        if (token) headers['Authorization'] = `Bearer ${token}`
        if (lastEventId) headers['Last-Event-ID'] = lastEventId

        const response = await fetch(`${getApiBaseUrl()}/api/flags/stream`, {
          headers,
          signal: controller.signal,
        })
        if (!response.ok || !response.body) {
          throw new Error(`flag stream HTTP ${response.status}`)
        }

        attempt = 0 // connected — reset backoff
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const { events, rest } = parseFrames(buffer)
          buffer = rest
          for (const e of filterNewEvents(events, seen)) {
            if (e.event_id != null) lastEventId = String(e.event_id)
            onEventRef.current(e)
          }
          if (seen.size > SEEN_CAP) seen.clear() // bounded; replays are rare
        }
        // Clean end-of-stream → reconnect (server cycles connections).
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
  }, [])
}
