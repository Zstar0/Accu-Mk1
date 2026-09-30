/**
 * The lab's time zone, for display only. Mirrors the backend default
 * (business-hours / scheduled-publish lab_timezone). Timestamps render on
 * the lab's wall clock, never the viewer's.
 */
export const LAB_TIME_ZONE = 'America/Los_Angeles'

/** Parse an ISO string the backend may send without a zone marker. Mk1-native
 *  rows serialise naive UTC (`captured_at.isoformat()`), which a browser would
 *  read as ITS local time; SENAITE-born strings carry an offset and parse as is. */
export function parseUtcIfNaive(iso: string): Date {
  return new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`)
}

/** "Sep 20, 26, 10:13 AM" on the lab's clock. */
export function formatLabDateTime(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: LAB_TIME_ZONE,
  })
}
