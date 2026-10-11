/** "2d ago" style relative time, Plain's way. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const m = Math.round((now - new Date(iso).getTime()) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 24 * 60) return `${Math.round(m / 60)}h ago`
  if (m < 30 * 24 * 60) return `${Math.round(m / 1440)}d ago`
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** "Tue, Sep 15, 2026" day divider label. */
export function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export const exact = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : ''
