/** Format an absolute minute count as a short human-readable duration. */
export function formatMinutes(min: number): string {
  const abs = Math.abs(min)
  if (abs < 60) return `${Math.round(abs)}m`
  if (abs < 60 * 24) return `${(abs / 60).toFixed(1).replace(/\.0$/, '')}h`
  const days = Math.floor(abs / (60 * 24))
  const hours = Math.round((abs - days * 60 * 24) / 60)
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

/** Format an SLA target minute count: whole hours as `Xh`, else `Xm`. */
export function formatTarget(min: number): string {
  return min % 60 === 0 ? `${min / 60}h` : `${min}m`
}
