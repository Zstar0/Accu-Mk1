import type { CheckInRecord } from '@/lib/api'

// Working-hours window for the time-of-day view. Hardcoded per spec (revisit if
// the lab wants it configurable). Off-hours bars are dimmed in the chart.
export const WORK_START_HOUR = 9
export const WORK_END_HOUR = 17

export type TimePeriod = '1M' | '3M' | '6M' | '1Y' | 'ALL'

export const PERIOD_DAYS: Record<TimePeriod, number | null> = {
  '1M': 30,
  '3M': 90,
  '6M': 180,
  '1Y': 365,
  ALL: null,
}

export interface HourBucket {
  hour: number // 0-23, browser-local
  count: number
  offHours: boolean
}

export interface DayBucket {
  day: string // YYYY-MM-DD, browser-local
  label: string // e.g. "Jun 1"
  count: number
}

export interface CheckInSummary {
  total: number
  avgMinutes: number | null // minutes since local midnight
  avgLabel: string
  busiestHour: number | null
  busiestWeekday: string | null
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// All bucketing is done in the browser's local timezone, matching the app-wide
// toLocaleString convention. date_received arrives as UTC ("…Z").
function local(iso: string): Date {
  return new Date(iso)
}

export function localHour(iso: string): number {
  return local(iso).getHours()
}

export function localDayKey(iso: string): string {
  const d = local(iso)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function isOffHours(hour: number): boolean {
  return hour < WORK_START_HOUR || hour >= WORK_END_HOUR
}

export function formatHourLabel(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12} ${hour < 12 ? 'AM' : 'PM'}`
}

export function minutesToLabel(min: number | null): string {
  if (min == null) return '—'
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

function formatDayLabel(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

export function filterByPeriod(
  records: CheckInRecord[],
  period: TimePeriod
): CheckInRecord[] {
  const days = PERIOD_DAYS[period]
  if (!days) return records
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  return records.filter(r => new Date(r.date_received) >= cutoff)
}

export function bucketByHour(records: CheckInRecord[]): HourBucket[] {
  const counts = new Array<number>(24).fill(0)
  for (const r of records) {
    const h = localHour(r.date_received)
    counts[h] = (counts[h] ?? 0) + 1
  }
  return counts.map((count, hour) => ({
    hour,
    count,
    offHours: isOffHours(hour),
  }))
}

export function bucketByDay(records: CheckInRecord[]): DayBucket[] {
  const map = new Map<string, number>()
  for (const r of records) {
    const k = localDayKey(r.date_received)
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, count]) => ({ day, label: formatDayLabel(day), count }))
}

export function computeSummary(records: CheckInRecord[]): CheckInSummary {
  if (records.length === 0) {
    return {
      total: 0,
      avgMinutes: null,
      avgLabel: '—',
      busiestHour: null,
      busiestWeekday: null,
    }
  }
  let totalMinutes = 0
  const hourCounts = new Array<number>(24).fill(0)
  const weekdayCounts = new Array<number>(7).fill(0)
  for (const r of records) {
    const d = local(r.date_received)
    const hr = d.getHours()
    const wd = d.getDay()
    totalMinutes += hr * 60 + d.getMinutes()
    hourCounts[hr] = (hourCounts[hr] ?? 0) + 1
    weekdayCounts[wd] = (weekdayCounts[wd] ?? 0) + 1
  }
  const avgMinutes = totalMinutes / records.length
  const busiestHour = hourCounts.indexOf(Math.max(...hourCounts))
  const busiestWeekdayIdx = weekdayCounts.indexOf(Math.max(...weekdayCounts))
  return {
    total: records.length,
    avgMinutes,
    avgLabel: minutesToLabel(avgMinutes),
    busiestHour,
    busiestWeekday: WEEKDAYS[busiestWeekdayIdx] ?? null,
  }
}
