import { getCustomerDossier } from '@/lib/api'

export function fmtMoney(s: string | null | undefined): string {
  const n = Number(s ?? 0)
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  return `$${Math.round(n).toLocaleString('en-US')}`
}

export const fmtPct = (x: number | null | undefined, dp = 1): string =>
  x == null ? 'n/a' : `${(x * 100).toFixed(dp)}%`

/** Period-over-period delta; within +/-5% reads as flat (grey). */
export function fmtDelta(x: number | null | undefined): {
  text: string
  tone: 'up' | 'down' | 'flat'
} {
  if (x == null) return { text: 'n/a', tone: 'flat' }
  const pct = Math.round(Math.abs(x) * 100)
  const text = `${x >= 0 ? '▲' : '▼'} ${pct}%`
  if (Math.abs(x) < 0.05) return { text, tone: 'flat' }
  return { text, tone: x > 0 ? 'up' : 'down' }
}

/** Change in a rate, in percentage points (the inputs are 0..1 shares). */
export function fmtPoints(
  value: number | null | undefined,
  prior: number | null | undefined
): { text: string; tone: 'up' | 'down' | 'flat' } {
  if (value == null || prior == null) return { text: 'n/a', tone: 'flat' }
  const pts = (value - prior) * 100
  const text = `${pts >= 0 ? '▲' : '▼'} ${Math.abs(pts).toFixed(1)} pts`
  if (Math.abs(pts) < 1) return { text, tone: 'flat' }
  return { text, tone: pts > 0 ? 'up' : 'down' }
}

export const STATUS_LABEL: Record<string, string> = {
  at_risk: 'At risk',
  dropping: 'Dropping',
  growing: 'Growing',
  steady: 'Steady',
  one_time: 'One-time',
}

export const STATUS_CLASS: Record<string, string> = {
  at_risk: 'bg-red-500/15 text-red-700 dark:text-red-300',
  dropping: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  growing: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  steady: 'bg-muted text-muted-foreground',
  one_time: 'bg-muted text-muted-foreground',
}

/** Cohort cell background: emerald scaled by share, red below 15%. */
export function cohortTint(share: number | null): string {
  if (share == null) return ''
  if (share < 0.15) return 'bg-red-500/30'
  // Full class literals so Tailwind's scanner emits them.
  if (share >= 0.35) return 'bg-emerald-500/50'
  if (share >= 0.25) return 'bg-emerald-500/40'
  return 'bg-emerald-500/30'
}

/** One query for a customer dossier so the Dashboard, the Orders-tab money
 *  cells and the guest header share a single fetch. */
export const dossierQuery = (key: string) => ({
  queryKey: ['customers', 'dossier', key],
  queryFn: () => getCustomerDossier(key),
  staleTime: 60_000,
})
