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

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' })
}
