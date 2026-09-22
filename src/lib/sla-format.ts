const CALENDAR_DAY = 60 * 24

/** How a tier's durations are written: the length of one "day", and whether
 *  the unit is business time (bh / bd) or calendar time (h / d). */
export interface SlaUnits {
  dayMinutes: number
  business: boolean
}

export const CALENDAR_UNITS: SlaUnits = {
  dayMinutes: CALENDAR_DAY,
  business: false,
}

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

/** Units for a tier. A business-hours tier counts only the open window, so its
 *  hours are business hours (bh) and its "day" is a business day (bd, 8h on
 *  prod, from `day_minutes` attached by `useSlaTiers`). Until that day length
 *  is known the tier still reads in bh but never rolls over to days. Any
 *  other tier is calendar time. */
export function tierUnits(
  tier:
    | { business_hours_only: boolean; day_minutes?: number }
    | null
    | undefined
): SlaUnits {
  if (!tier?.business_hours_only) return CALENDAR_UNITS
  return {
    dayMinutes: tier.day_minutes || Number.POSITIVE_INFINITY,
    business: true,
  }
}

function daysAndHours(min: number, u: SlaUnits): string {
  const h = u.business ? 'bh' : 'h'
  const d = u.business ? 'bd' : 'd'
  let days = Math.floor(min / u.dayMinutes)
  let hours = Math.round((min - days * u.dayMinutes) / 60)
  // Rounding carry: 1d 7.6h on an 8h day is 2d, never "1d 8h".
  if (hours * 60 >= u.dayMinutes) {
    days += 1
    hours = 0
  }
  return hours > 0 ? `${days}${d} ${hours}${h}` : `${days}${d}`
}

/** Format an absolute minute count as a short human-readable duration in the
 *  tier's units: `4.8h` / `2d 3h` for calendar time, `4.8bh` / `2bd 3bh` for
 *  business time. Minutes are minutes either way (`45m`). */
export function formatMinutes(
  min: number,
  units: SlaUnits = CALENDAR_UNITS
): string {
  const abs = Math.abs(min)
  if (abs < 60) return `${Math.round(abs)}m`
  if (abs < units.dayMinutes) {
    const h = (abs / 60).toFixed(1).replace(/\.0$/, '')
    return `${h}${units.business ? 'bh' : 'h'}`
  }
  return daysAndHours(abs, units)
}

/** Format an SLA target minute count: whole hours as `Xh`, else `Xm`. For
 *  targets of a day or more, append a day-equivalent in parentheses so
 *  analysts can size up "48h" vs "336h" at a glance, e.g. `48h (2d)`,
 *  `336h (14d)`, `1500m (1d 1h)`. In business units the same 32h reads
 *  `32bh (4bd)`: four business days. */
export function formatTarget(
  min: number,
  units: SlaUnits = CALENDAR_UNITS
): string {
  const h = units.business ? 'bh' : 'h'
  const base = min % 60 === 0 ? `${min / 60}${h}` : `${min}m`
  if (min < units.dayMinutes) return base
  return `${base} (${daysAndHours(min, units)})`
}
