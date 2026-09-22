const CALENDAR_DAY = 60 * 24

/** Length of one business day in minutes: the lab's open..close window from
 *  the business-hours config ("HH:MM[:SS]"). Undefined when the config is
 *  missing or the window is inverted, so callers fall back to 24h days. */
export function businessDayMinutes(
  cfg: { open_time: string; close_time: string } | null | undefined
): number | undefined {
  if (!cfg) return undefined
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number)
    return h === undefined ||
      m === undefined ||
      Number.isNaN(h) ||
      Number.isNaN(m)
      ? NaN
      : h * 60 + m
  }
  const len = toMin(cfg.close_time) - toMin(cfg.open_time)
  return len > 0 ? len : undefined
}

/** The day length a tier's durations are sized in. A business-hours tier
 *  counts only the open window, so its "day" is a business day (8h on prod);
 *  everything else is a 24h day. `day_minutes` is attached by `useSlaTiers`. */
export function tierDayMinutes(
  tier:
    | { business_hours_only: boolean; day_minutes?: number }
    | null
    | undefined
): number {
  return tier?.business_hours_only && tier.day_minutes
    ? tier.day_minutes
    : CALENDAR_DAY
}

function daysAndHours(min: number, dayMinutes: number): string {
  let days = Math.floor(min / dayMinutes)
  let hours = Math.round((min - days * dayMinutes) / 60)
  // Rounding carry: 1d 7.6h on an 8h day is 2d, never "1d 8h".
  if (hours * 60 >= dayMinutes) {
    days += 1
    hours = 0
  }
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

/** Format an absolute minute count as a short human-readable duration.
 *  `dayMinutes` is the length of one "d": 24h by default, the business day
 *  for business-hours tiers (see `tierDayMinutes`). */
export function formatMinutes(min: number, dayMinutes = CALENDAR_DAY): string {
  const abs = Math.abs(min)
  if (abs < 60) return `${Math.round(abs)}m`
  if (abs < dayMinutes) return `${(abs / 60).toFixed(1).replace(/\.0$/, '')}h`
  return daysAndHours(abs, dayMinutes)
}

/** Format an SLA target minute count: whole hours as `Xh`, else `Xm`. For
 *  targets of a day or more, append a day-equivalent in parentheses so
 *  analysts can size up "48h" vs "336h" at a glance, e.g. `48h (2d)`,
 *  `336h (14d)`, `1500m (1d 1h)`. With a business `dayMinutes` the same 48h
 *  reads `48h (6d)`: six business days. */
export function formatTarget(min: number, dayMinutes = CALENDAR_DAY): string {
  const base = min % 60 === 0 ? `${min / 60}h` : `${min}m`
  if (min < dayMinutes) return base
  return `${base} (${daysAndHours(min, dayMinutes)})`
}
