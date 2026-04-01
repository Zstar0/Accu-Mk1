import type { InboxPriority } from '@/lib/api'

export type { InboxPriority }

interface PriorityBadgeProps {
  priority: InboxPriority
  className?: string
}

const PRIORITY_STYLES: Record<InboxPriority, string> = {
  normal:
    'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-900/30 dark:text-zinc-300 dark:border-zinc-700',
  high: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700',
  expedited:
    'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700 animate-pulse',
}

const PRIORITY_LABELS: Record<InboxPriority, string> = {
  normal: 'Normal',
  high: 'High',
  expedited: 'Expedited',
}

export function PriorityBadge({ priority, className = '' }: PriorityBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLES[priority]} ${className}`}
    >
      {PRIORITY_LABELS[priority]}
    </span>
  )
}
