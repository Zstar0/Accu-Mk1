/**
 * Tiny date helpers for flag cards + threads. No date-fns in this project, and
 * the needs are small (a relative "10m" and a "3:42 PM" clock), so we keep it
 * dependency-free.
 */

/** Parse a backend ISO timestamp. Naive (tz-less) values are treated as UTC,
 *  matching how the backend stores them. Returns NaN-safe epoch ms. */
function toMs(iso: string): number {
  if (!iso) return NaN
  // If the string carries no timezone, assume UTC.
  const hasTz = /[zZ]|[+-]\d\d:?\d\d$/.test(iso)
  const ms = Date.parse(hasTz ? iso : `${iso}Z`)
  return ms
}

/** Compact relative time: "just now", "10m", "3h", "2d", else a short date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const ms = toMs(iso)
  if (Number.isNaN(ms)) return ''
  const diff = Math.max(0, now - ms)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

/** Wall-clock time for thread entries, e.g. "3:42 PM". */
export function formatClock(iso: string): string {
  const ms = toMs(iso)
  if (Number.isNaN(ms)) return ''
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Compact absolute date+time, e.g. "Jun 30, 4:41 PM". */
export function formatDateTime(iso: string): string {
  const ms = toMs(iso)
  if (Number.isNaN(ms)) return ''
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
