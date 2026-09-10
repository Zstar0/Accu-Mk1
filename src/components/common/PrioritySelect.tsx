import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { EffectivePriority, PriorityLevel } from '@/lib/api-priorities'
import {
  priorityByKey,
  useActivePriorities,
  useAssignPriority,
  usePriorities,
} from '@/services/priorities'
import { priorityTooltip } from '@/components/common/PriorityGlyph'
import { cn } from '@/lib/utils'

const INHERIT = '__inherit__'

export function PrioritySelect({
  level,
  id,
  explicitKey,
  effective,
  compact = false,
  className,
}: {
  level: PriorityLevel
  id: string
  explicitKey: string | null
  effective: EffectivePriority | null | undefined
  compact?: boolean
  className?: string
}) {
  const { data: all } = usePriorities()
  const { data: active } = useActivePriorities()
  const assign = useAssignPriority()
  const effName = priorityByKey(all, effective?.key)?.name ?? 'Default'
  const inheritLabel =
    effective && effective.source_level !== 'default'
      ? `Inherit (${priorityTooltip(effName, effective)})`
      : 'Inherit (Default)'
  return (
    <Select
      value={explicitKey ?? INHERIT}
      disabled={assign.isPending || !active}
      onValueChange={v =>
        assign.mutate({ level, id, priority_key: v === INHERIT ? null : v })
      }
    >
      <SelectTrigger
        className={cn(compact ? 'h-7 text-xs' : 'h-8 text-sm', className)}
        aria-label="Priority"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={INHERIT}>{inheritLabel}</SelectItem>
        {/* Every active priority is listed, the default included: setting
            Default explicitly at a lower level deliberately overrides a
            higher level's value (spec fixture case 8). */}
        {(active ?? []).map(p => (
          <SelectItem key={p.key} value={p.key}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
