/** A received-date window: a rolling period ('30d'...'all') or one calendar month ('2026-09'). */
export type ReceivedWindow = string

export const WINDOW_PERIODS: {
  key: ReceivedWindow
  label: string
  days?: number
}[] = [
  { key: '30d', label: '30D', days: 30 },
  { key: '90d', label: '90D', days: 90 },
  { key: '6m', label: '6M', days: 182 },
  { key: '1y', label: '1Y', days: 365 },
  { key: 'all', label: 'All' },
]

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Inclusive lab-day bounds for the window; undefined = open end. */
export function windowRange(
  win: ReceivedWindow,
  today: Date = new Date()
): { from?: string; to?: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(win)
  if (m) {
    const y = Number(m[1])
    const mo = Number(m[2])
    return { from: iso(new Date(y, mo - 1, 1)), to: iso(new Date(y, mo, 0)) }
  }
  const p = WINDOW_PERIODS.find(x => x.key === win)
  if (!p?.days) return {}
  const from = new Date(today)
  from.setDate(from.getDate() - p.days)
  return { from: iso(from) }
}

/** Months (YYYY-MM) from `start` through the current month, newest first. */
export function monthOptions(
  start = '2026-02',
  today: Date = new Date()
): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = []
  const [sy, sm] = start.split('-').map(Number)
  const d = new Date(today.getFullYear(), today.getMonth(), 1)
  while (
    d.getFullYear() > (sy ?? 0) ||
    (d.getFullYear() === sy && d.getMonth() + 1 >= (sm ?? 1))
  ) {
    out.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    })
    d.setMonth(d.getMonth() - 1)
  }
  return out
}
