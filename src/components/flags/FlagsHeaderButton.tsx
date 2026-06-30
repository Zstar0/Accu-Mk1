import { Flag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useFlagSummary } from '@/hooks/use-flags'
import { useUIStore } from '@/store/ui-store'
import { flagTypeDef } from '@/components/flags/flag-catalog'
import { useFlagTypes, useFlagTypesMap } from '@/services/flag-types'

/** Stable DOM id so the toast fly-home animation (Task 7) can locate the
 *  button to fly into. */
export const FLAGS_BUTTON_ID = 'flags-header-button'

/**
 * Flags entry button — sits beside Worksheets in the top bar. Renders one small
 * colored count chip per non-zero flag type (the segmented-counts design, A in
 * toolbar-badge.html), pulses when a relevant event has arrived while the flyout
 * is closed, and opens the flyout on click.
 */
export function FlagsHeaderButton({ hasNew = false }: { hasNew?: boolean }) {
  const { data: summary } = useFlagSummary()
  const flyoutOpen = useUIStore(state => state.flagsFlyoutOpen)
  // Color/label resolution (incl. inactive types + static fallback) and the
  // type rows (for sort_order). Both hooks share one query cache entry.
  const typesMap = useFlagTypesMap()
  const { data: typeRows } = useFlagTypes({})

  const byType = summary?.by_type ?? {}
  const sortOrder = new Map((typeRows ?? []).map(t => [t.slug, t.sort_order]))
  const orderOf = (slug: string) =>
    sortOrder.get(slug) ?? Number.MAX_SAFE_INTEGER
  // Drive the chips off the COUNT keys (summary.by_type), not the active type
  // list: a deactivated type with open flags must still show its count, and an
  // active-but-empty type needs no chip. Resolve color/label through the map.
  const chips = Object.keys(byType)
    .filter(slug => (byType[slug] ?? 0) > 0)
    .sort((a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b))
  // Glow is tied to NEW arrivals, not a standing count — and never while the
  // flyout (where you'd see them) is already open.
  const glow = hasNew && !flyoutOpen

  return (
    <Button
      id={FLAGS_BUTTON_ID}
      variant="ghost"
      size="sm"
      className={cn(
        'gap-1.5 h-7 px-2.5 bg-accent text-foreground hover:bg-accent/80 hover:shadow-sm cursor-pointer',
        glow && 'flags-glow'
      )}
      onClick={() => useUIStore.getState().openFlagsFlyout()}
    >
      <Flag className="h-3.5 w-3.5" />
      <span className="text-xs">Flags</span>
      {chips.map(type => {
        const def = typesMap[type] ?? flagTypeDef(type)
        return (
          <span
            key={type}
            className="flex h-4 min-w-4 items-center justify-center rounded-full text-[10px] text-white font-semibold px-1 leading-none"
            style={{ backgroundColor: def.color }}
            title={`${def.label}: ${byType[type]}`}
          >
            {(byType[type] ?? 0) > 99 ? '99+' : byType[type]}
          </span>
        )
      })}
    </Button>
  )
}

export default FlagsHeaderButton
