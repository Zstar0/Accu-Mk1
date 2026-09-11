import { PriorityGlyph } from '@/components/common/PriorityGlyph'
import { PrioritySelect } from '@/components/common/PrioritySelect'
import type { EffectivePriority } from '@/lib/api-priorities'

/**
 * Priority control for a sample-details surface (sample-priority spec §5).
 *
 * The registry pk is the write target: a sample only gets a `lims_samples`
 * row once it is received, so a SENAITE-only sample has nothing to write
 * against — it shows the resolved glyph plus a hint instead of a control.
 *
 * `onAssigned` exists because the sample-details page holds its lookup in
 * local state rather than react-query, so the assign mutation's cache
 * invalidation cannot refresh it; the page passes its own refetch here.
 */
export function SamplePriorityRow({
  registryPk,
  explicitKey,
  effective,
  level = 'sample',
  ariaLabel,
  onAssigned,
}: {
  registryPk: number | null | undefined
  explicitKey: string | null
  effective: EffectivePriority | null | undefined
  level?: 'sample' | 'vial'
  /** Forwarded to the select. Omitted keeps PrioritySelect's bare 'Priority'. */
  ariaLabel?: string
  onAssigned?: () => void
  /** Details still loading: show a quiet placeholder, never the no-record hint. */
  loading?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-[11px] text-muted-foreground">Priority</span>
      <span className="flex items-center gap-2">
        <PriorityGlyph priority={effective} size="row" />
        {loading && !registryPk ? (
          <span className="text-xs text-muted-foreground">…</span>
        ) : registryPk ? (
          <PrioritySelect
            level={level}
            id={String(registryPk)}
            explicitKey={explicitKey}
            effective={effective}
            compact
            className="w-56"
            ariaLabel={ariaLabel}
            onAssigned={onAssigned}
          />
        ) : (
          <span className="text-xs text-muted-foreground">
            No registry record for this sample yet
          </span>
        )}
      </span>
    </div>
  )
}
