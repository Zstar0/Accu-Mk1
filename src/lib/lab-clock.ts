import { useSyncExternalStore } from 'react'
import type { BusinessHoursConfig } from '@/lib/api'

/**
 * Is the lab's SLA clock running right now? Judged on the lab's wall clock
 * (the business-hours config's timezone), never the viewer's: a viewer in
 * Central at 6 PM sees no pause while the Pacific lab is still open.
 *
 * Mirrors the day-window rule of backend/sla_engine.py compute_business_minutes:
 * minutes accrue only inside [open, close) on a working, non-holiday day.
 */

export type LabClockReason =
  | 'open'
  | 'before_open'
  | 'after_close'
  | 'closed_day'
  | 'holiday'

export interface LabClockState {
  paused: boolean
  reason: LabClockReason
  /** Next instant the clock runs again; null when open or when no working day
   *  exists in the next 400 days (misconfiguration). */
  resumesAt: Date | null
}

interface Wall {
  y: number
  m: number
  d: number
  /** Minutes since midnight on the lab's clock. */
  minutes: number
  /** Python weekday, Mon=0..Sun=6, matching `working_days`. */
  weekday: number
}

const WEEKDAY: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
}

function wallIn(at: Date, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return {
    y: +get('year'),
    m: +get('month'),
    d: +get('day'),
    minutes: (+get('hour') % 24) * 60 + +get('minute'),
    weekday: WEEKDAY[get('weekday')] ?? -1,
  }
}

const hm = (s: string) => {
  const [h, m] = s.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

const isoDay = (w: Wall) =>
  `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`

/** The instant at which the lab's wall clock reads y-m-d + minutes. */
function labWallToDate(
  y: number,
  m: number,
  d: number,
  minutes: number,
  timeZone: string
): Date {
  const guess = new Date(
    Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60)
  )
  const w = wallIn(guess, timeZone)
  const shown = Date.UTC(
    w.y,
    w.m - 1,
    w.d,
    Math.floor(w.minutes / 60),
    w.minutes % 60
  )
  return new Date(guess.getTime() - (shown - guess.getTime()))
}

export function labClockState(
  now: Date,
  cfg: BusinessHoursConfig,
  holidays: ReadonlySet<string>
): LabClockState {
  const tz = cfg.timezone
  const open = hm(cfg.open_time)
  const close = hm(cfg.close_time)
  const working = (w: Wall) =>
    cfg.working_days.includes(w.weekday) && !holidays.has(isoDay(w))
  const w = wallIn(now, tz)
  const today = working(w)

  if (today && w.minutes >= open && w.minutes < close) {
    return { paused: false, reason: 'open', resumesAt: null }
  }
  const reason: LabClockReason = !cfg.working_days.includes(w.weekday)
    ? 'closed_day'
    : holidays.has(isoDay(w))
      ? 'holiday'
      : w.minutes < open
        ? 'before_open'
        : 'after_close'
  if (today && w.minutes < open) {
    return {
      paused: true,
      reason,
      resumesAt: labWallToDate(w.y, w.m, w.d, open, tz),
    }
  }
  // Walk forward from noon today in 24h steps (noon keeps DST shifts from
  // skipping or repeating a date) to the next working day.
  let cursor = labWallToDate(w.y, w.m, w.d, 12 * 60, tz)
  for (let i = 0; i < 400; i++) {
    cursor = new Date(cursor.getTime() + 24 * 3600 * 1000)
    const c = wallIn(cursor, tz)
    if (working(c)) {
      return {
        paused: true,
        reason,
        resumesAt: labWallToDate(c.y, c.m, c.d, open, tz),
      }
    }
  }
  return { paused: true, reason, resumesAt: null }
}

/** "Tue 9:00 AM" in the viewer's local time, like the Received line. */
export function formatResumesAt(at: Date | null): string {
  if (!at) return '?'
  return at.toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// ---------------------------------------------------------------------------
// Store: one computed clock state for every SLA cell on the page. Fed by
// `LabClockFeeder` (mounted once for signed-in users), read with
// `useLabClockState`. Cells stay free of React Query, so a cell rendered
// alone (tests, previews) simply sees null and shows no moon.

const listeners = new Set<() => void>()
let current: LabClockState | null = null

export function setLabClockState(next: LabClockState | null): void {
  const same =
    next === current ||
    (next !== null &&
      current !== null &&
      next.paused === current.paused &&
      next.reason === current.reason &&
      (next.resumesAt?.getTime() ?? null) ===
        (current.resumesAt?.getTime() ?? null))
  if (same) return
  current = next
  listeners.forEach(l => l())
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
const getSnapshot = () => current

/** The lab clock state, or null before the config loads (or when nothing
 *  feeds the store). */
export function useLabClockState(): LabClockState | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
