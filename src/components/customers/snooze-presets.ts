/** Snooze presets shared by the sidebar status menu and the action bar's More menu. */
function at8(daysAhead: number, weekday?: number): string {
  const d = new Date()
  if (weekday !== undefined)
    d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7 || 7))
  else d.setDate(d.getDate() + daysAhead)
  d.setHours(8, 0, 0, 0)
  return d.toISOString()
}

export const SNOOZE_PRESETS: Record<string, () => string> = {
  'snooze:1h': () => new Date(Date.now() + 3_600_000).toISOString(),
  'snooze:tomorrow': () => at8(1),
  'snooze:monday': () => at8(0, 1),
}
