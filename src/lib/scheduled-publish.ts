/**
 * Scheduled publish: the few date conversions the dialog and badges need.
 * No date library on purpose (the app has none).
 *
 * The picker is a native `datetime-local`, whose value has no offset and
 * means BROWSER-local time. The API speaks ISO UTC with a Z. The lab date
 * printed on the certificate is computed server-side in the lab timezone;
 * `labDate` only previews it.
 */
import type { ScheduledPublish } from '@/lib/api'
import { formatMinutes } from '@/lib/sla-format'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** ISO (UTC, with Z) -> the `YYYY-MM-DDTHH:MM` a datetime-local input takes, in browser-local time. */
export function toLocalInputValue(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local value (browser-local) -> ISO UTC with a Z; null when unparseable. */
export function localInputToIso(value: string): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** MM/DD/YYYY of an instant in the lab timezone: what the COA will print. */
export function labDate(iso: string, timeZone: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
    }).format(d)
  } catch {
    return ''
  }
}

/** Short browser-local rendering for badges: "Sep 19, 10:00 AM". */
export function fmtWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Rows the report parks: a schedule that is still going to fire. */
export function isParkedSchedule(
  s: ScheduledPublish | null | undefined
): boolean {
  return !!s && (s.status === 'pending' || s.status === 'firing')
}

/** "in 1d 4h" / "due" for a pending row, measured against the server's
 *  `generated_at` so the render stays pure. */
export function untilText(scheduledAt: string, generatedAt: string): string {
  const mins =
    (new Date(scheduledAt).getTime() - new Date(generatedAt).getTime()) / 60000
  if (Number.isNaN(mins)) return ''
  return mins <= 0 ? 'due' : `in ${formatMinutes(mins)}`
}
