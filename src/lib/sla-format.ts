/** Format an absolute minute count as a short human-readable duration. */
export function formatMinutes(min: number): string {
  const abs = Math.abs(min)
  if (abs < 60) return `${Math.round(abs)}m`
  if (abs < 60 * 24) return `${(abs / 60).toFixed(1).replace(/\.0$/, '')}h`
  const days = Math.floor(abs / (60 * 24))
  const hours = Math.round((abs - days * 60 * 24) / 60)
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

/** Format an SLA target minute count: whole hours as `Xh`, else `Xm`. For
 *  targets ≥24h, append a day-equivalent in parentheses so analysts can
 *  size up "48h" vs "336h" at a glance — e.g. `48h (2d)`, `336h (14d)`,
 *  `1500m (1d 1h)`. The hour value stays primary because tier targets are
 *  typically configured in hours. */
export function formatTarget(min: number): string {
  const base = min % 60 === 0 ? `${min / 60}h` : `${min}m`
  if (min < 60 * 24) return base
  const days = Math.floor(min / (60 * 24))
  const remHours = Math.round((min - days * 60 * 24) / 60)
  const dayPart = remHours > 0 ? `${days}d ${remHours}h` : `${days}d`
  return `${base} (${dayPart})`
}
