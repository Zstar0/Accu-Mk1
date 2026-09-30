/**
 * The lab's time zone, for display only. Mirrors the backend default
 * (business-hours / scheduled-publish lab_timezone). Timestamps render on
 * the lab's wall clock, never the viewer's.
 */
export const LAB_TIME_ZONE = 'America/Los_Angeles'

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
