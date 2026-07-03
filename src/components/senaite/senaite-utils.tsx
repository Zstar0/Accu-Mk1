/**
 * Shared utilities for SENAITE components — status badges, date formatting, labels.
 */

export const STATE_LABELS: Record<string, { label: string; className: string }> = {
  sample_registered:         { label: 'Registered',       className: 'bg-zinc-700 text-zinc-200' },
  sample_due:                { label: 'Due',               className: 'bg-yellow-900 text-yellow-300' },
  sample_received:           { label: 'Received',          className: 'bg-blue-900 text-blue-300' },
  waiting_for_addon_results: { label: 'Waiting Addon',     className: 'bg-indigo-900 text-indigo-300' },
  ready_for_review:          { label: 'Ready for Review',  className: 'bg-cyan-900 text-cyan-300' },
  to_be_verified:            { label: 'To Verify',         className: 'bg-orange-900 text-orange-300' },
  verified:                  { label: 'Verified',          className: 'bg-green-900 text-green-300' },
  published:                 { label: 'Published',         className: 'bg-purple-900 text-purple-300' },
  cancelled:                 { label: 'Cancelled',         className: 'bg-red-900 text-red-300' },
  invalid:                   { label: 'Invalid',           className: 'bg-red-900 text-red-300' },
}

export function StateBadge({ state }: { state: string }) {
  const config = STATE_LABELS[state] ?? { label: state, className: 'bg-zinc-700 text-zinc-200' }
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${config.className}`}>
      {config.label}
    </span>
  )
}

/**
 * Display-layer rounding for numeric analysis results.
 *
 * Promoted sub-sample values land on the parent SENAITE AR at full precision
 * (e.g. Fill Volume 9.710267415 mL). The sample-details row should show 2 dp,
 * but we never touch the stored value and we don't restyle results that are
 * already fine. Surgical by design: only a clean finite number carrying MORE
 * than 2 decimal places is trimmed to 2 dp. Integers, <=2dp values, values
 * with a unit suffix, and any non-numeric text pass through verbatim.
 *
 * (A per-AnalysisService precision option will supersede this hardcoded 2 dp as
 * part of the spec/validation-engine migration; until then 2 dp is the default.)
 */
export function formatNumericResult(result: string | null): string | null {
  if (result == null) return result
  const trimmed = result.trim()
  if (trimmed === '') return result
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return result // non-numeric (incl. unit suffix) — leave as-is
  const dot = trimmed.indexOf('.')
  if (dot === -1) return result // integer — leave as-is
  if (trimmed.length - dot - 1 <= 2) return result // already <=2 dp — leave as-is
  return n.toFixed(2)
}

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' })
}
