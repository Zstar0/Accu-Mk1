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
  onAssigned,
}: {
  level: PriorityLevel
  id: string
  explicitKey: string | null
  effective: EffectivePriority | null | undefined
  compact?: boolean
  className?: string
  /** Called after a successful assign. For surfaces whose data does not live
   *  in react-query (sample-details keeps its lookup in local state), so the
   *  mutation's cache invalidation alone would leave them stale. */
  onAssigned?: () => void
}) {
  const { data: all } = usePriorities()
  const { data: active } = useActivePriorities()
  const assign = useAssignPriority()
  const effName = priorityByKey(all, effective?.key)?.name ?? 'Default'
  const inheritLabel =
    effective && effective.source_level !== 'default'
      ? `Inherit (${priorityTooltip(effName, effective)})`
      : 'Inherit (Default)'
  // Every active priority is listed, the default included: setting Default
  // explicitly at a lower level deliberately overrides a higher level's value
  // (spec fixture case 8).
  const options = (active ?? []).map(p => ({ key: p.key, label: p.name }))
  // An explicitly-set priority that has since been deactivated (or pruned)
  // still has to be an option, or the controlled value matches no item and the
  // trigger renders blank.
  if (active && explicitKey && !active.some(p => p.key === explicitKey)) {
    const stored = priorityByKey(all, explicitKey)
    options.push({
      key: explicitKey,
      label: stored ? `${stored.name} (inactive)` : `${explicitKey} (unknown)`,
    })
  }
  return (
    <Select
      value={explicitKey ?? INHERIT}
      disabled={assign.isPending || !active}
      onValueChange={v =>
        assign.mutate(
          { level, id, priority_key: v === INHERIT ? null : v },
          { onSuccess: onAssigned }
        )
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
        {options.map(o => (
          <SelectItem key={o.key} value={o.key}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
