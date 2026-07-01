import { Flag } from 'lucide-react'
import type { CSSProperties, MouseEvent } from 'react'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'
import {
  useOpenFlagsBySample,
  type FlagRollup,
} from '@/hooks/use-open-flags-by-sample'
import { useFlagTypesMap } from '@/services/flag-types'
import { flagTypeDef } from '@/components/flags/flag-catalog'
import { RaiseFlagButton } from '@/components/flags/RaiseFlagButton'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * Compact, always-clickable at-a-glance flag affordance for overview rows
 * (Plan 6). Reads the page-wide {@link useOpenFlagsBySample} rollup — NOT a
 * per-row query — so a dense table mounts one indicator per row off a single
 * fetch.
 *
 * - **Flagged** → a small flag in the dominant type's color, plus a tiny count
 *   when >1. Tooltip carries the breakdown. Click opens the flyout scoped to
 *   this sample (`openFlagsForEntity`) or, for an order, rolled up across its
 *   samples (`openFlagsForSamples`).
 * - **Unflagged** → a dim flag (brightens on hover). Click opens the Raise-a-flag
 *   compose directly (sample scope presets the target; order scope picks a
 *   sample) — no empty flyout to click through.
 */

const EMPTY_ROLLUP: FlagRollup = {
  count: 0,
  flags: [],
  dominantType: null,
  dominantColor: null,
}

export type FlagIndicatorScope =
  | { kind: 'sample'; sampleId: string }
  | { kind: 'order'; orderId: string; sampleIds: string[]; label: string }

export interface FlagIndicatorProps {
  scope: FlagIndicatorScope
  /** `pill` adds a faint type-tinted chip (order-id cell); `glyph` is the bare
   *  icon for dense rows (kanban, sample card). */
  variant?: 'pill' | 'glyph'
  className?: string
}

export function FlagIndicator({
  scope,
  variant = 'glyph',
  className,
}: FlagIndicatorProps) {
  const { map, rollupForSamples } = useOpenFlagsBySample()
  const typesMap = useFlagTypesMap()

  const rollup =
    scope.kind === 'sample'
      ? (map.get(scope.sampleId) ?? EMPTY_ROLLUP)
      : rollupForSamples(scope.sampleIds)

  const flagged = rollup.count > 0

  const handleClick = (e: MouseEvent) => {
    // Rows/cards carry their own navigation handlers — don't trigger them.
    e.stopPropagation()
    if (scope.kind === 'sample') {
      useUIStore.getState().openFlagsForEntity('sample', scope.sampleId, {
        includeDescendants: true,
      })
    } else {
      useUIStore.getState().openFlagsForSamples(scope.label, scope.sampleIds)
    }
  }

  const tip = flagged
    ? scope.kind === 'order'
      ? orderBreakdown(rollup, scope.sampleIds, map)
      : typeBreakdown(rollup, typesMap)
    : 'No flags — click to raise one'

  const color = rollup.dominantColor ?? undefined
  const pill = variant === 'pill'

  const indicatorButton = (
    <button
      type="button"
      data-testid="flag-indicator"
      data-flagged={flagged ? 'true' : 'false'}
      // Flagged → open the scoped flyout. Unflagged → the button is a
      // RaiseFlagButton trigger (below), so just stop the row's own nav.
      onClick={flagged ? handleClick : e => e.stopPropagation()}
      aria-label={tip}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded leading-none transition-colors',
        pill && 'px-1 py-0.5',
        !flagged && 'text-muted-foreground/40 hover:text-muted-foreground/80',
        className
      )}
      style={
        flagged
          ? ({
              color,
              ...(pill
                ? { backgroundColor: tintFor(rollup.dominantColor) }
                : {}),
            } as CSSProperties)
          : undefined
      }
    >
      <Flag
        className="h-3.5 w-3.5 shrink-0"
        fill={flagged ? 'currentColor' : 'none'}
      />
      {flagged && rollup.count > 1 && (
        <span className="text-[10px] font-semibold leading-none tabular-nums">
          {rollup.count > 99 ? '99+' : rollup.count}
        </span>
      )}
    </button>
  )

  // Unflagged → clicking raises a flag directly (no empty flyout). Sample scope
  // presets the target; order scope offers a "Which sample?" picker.
  if (!flagged) {
    return (
      <RaiseFlagButton
        entityType={scope.kind === 'sample' ? 'sample' : undefined}
        entityId={scope.kind === 'sample' ? scope.sampleId : undefined}
        candidates={
          scope.kind === 'order'
            ? scope.sampleIds.map(id => ({
                entityType: 'sample',
                entityId: id,
                label: id,
              }))
            : undefined
        }
        trigger={indicatorButton}
      />
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{indicatorButton}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}

/** "2 Blockers · 1 Question" — per-type counts for a single sample. */
function typeBreakdown(
  rollup: FlagRollup,
  typesMap: ReturnType<typeof useFlagTypesMap>
): string {
  const counts = new Map<string, number>()
  for (const f of rollup.flags)
    counts.set(f.type, (counts.get(f.type) ?? 0) + 1)
  return [...counts.entries()]
    .map(([type, n]) => {
      const label = (typesMap[type] ?? flagTypeDef(type)).label
      return `${n} ${label}${n > 1 ? 's' : ''}`
    })
    .join(' · ')
}

/** "3 flags across 2 samples" — order rollup summary. */
function orderBreakdown(
  rollup: FlagRollup,
  sampleIds: string[],
  map: Map<string, FlagRollup>
): string {
  const samples = new Set(sampleIds.filter(id => map.has(id))).size
  const fp = rollup.count === 1 ? 'flag' : 'flags'
  const sp = samples === 1 ? 'sample' : 'samples'
  return `${rollup.count} ${fp} across ${samples} ${sp}`
}

/** A faint type-tinted background for the pill variant (≈13% alpha on a 6-digit
 *  hex). Falls back to undefined for non-hex / missing colors. */
function tintFor(color: string | null): string | undefined {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return undefined
  return `${color}22`
}

export default FlagIndicator
