import {
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  Flame,
  Minus,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  EffectivePriority,
  PriorityColor,
  PriorityIcon,
} from '@/lib/api-priorities'
import { priorityByKey, usePriorities } from '@/services/priorities'

const ICONS: Record<PriorityIcon, typeof ChevronUp> = {
  'chevrons-up': ChevronsUp,
  'chevron-up': ChevronUp,
  minus: Minus,
  'chevron-down': ChevronDown,
  'chevrons-down': ChevronsDown,
  flame: Flame,
}
// Full class strings so Tailwind keeps them.
const TEXT: Record<PriorityColor, string> = {
  red: 'text-red-600 dark:text-red-400',
  amber: 'text-amber-600 dark:text-amber-400',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  sky: 'text-sky-600 dark:text-sky-400',
  violet: 'text-violet-600 dark:text-violet-400',
  zinc: 'text-zinc-600 dark:text-zinc-400',
}
const TINT: Record<PriorityColor, string> = {
  red: 'bg-red-500/10 border-red-500/20',
  amber: 'bg-amber-500/10 border-amber-500/20',
  emerald: 'bg-emerald-500/10 border-emerald-500/20',
  sky: 'bg-sky-500/10 border-sky-500/20',
  violet: 'bg-violet-500/10 border-violet-500/20',
  zinc: 'bg-zinc-500/10 border-zinc-500/20',
}
const SIZE = {
  row: { box: 'w-[18px] h-[18px]', icon: 14 },
  card: { box: 'w-[22px] h-[22px] rounded border', icon: 17 },
  header: { box: 'w-7 h-7 rounded-md border', icon: 21 },
}

// Tasks 4/5/7/8/9 import this tooltip builder from here; a non-component
// export costs Fast Refresh on this file only.
// eslint-disable-next-line react-refresh/only-export-components
export function priorityTooltip(name: string, p: EffectivePriority): string {
  switch (p.source_level) {
    case 'customer':
      return `${name} via customer${p.source_id ? ` (${p.source_id})` : ''}`
    case 'order':
      return `${name} via order${p.source_id ? ` ${p.source_id}` : ''}`
    case 'sample':
      return `${name} via sample`
    case 'vial':
      return `${name} via vial`
    default:
      return name
  }
}

export function PriorityGlyph({
  priority,
  size = 'row',
  showLabel = false,
  className,
  preview = false,
}: {
  priority: EffectivePriority | null | undefined
  size?: keyof typeof SIZE
  showLabel?: boolean
  /** Editor preview: render the default priority's glyph too (lists never do). */
  preview?: boolean
  className?: string
}) {
  const { data: list } = usePriorities()
  const def = priorityByKey(list, priority?.key)
  if (!priority || !def || (def.is_default && !preview)) return null
  const Icon = ICONS[def.icon] ?? Minus
  const tip = priorityTooltip(def.name, priority)
  const tinted = size !== 'row'
  return (
    <span
      role="img"
      aria-label={tip}
      title={tip}
      className={cn(
        'inline-flex items-center justify-center shrink-0 align-middle',
        SIZE[size].box,
        TEXT[def.color],
        tinted && TINT[def.color],
        def.pulse && 'motion-safe:animate-pulse',
        className
      )}
    >
      <Icon size={SIZE[size].icon} strokeWidth={2.4} aria-hidden="true" />
      {showLabel && (
        <span className="ms-1 text-xs font-medium">{def.name}</span>
      )}
    </span>
  )
}
