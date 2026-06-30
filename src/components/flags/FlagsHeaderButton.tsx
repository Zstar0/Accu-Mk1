import { Flag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useFlagSummary } from '@/hooks/use-flags'
import { useUIStore } from '@/store/ui-store'
import { FLAG_TYPE_ORDER, FLAG_TYPES } from '@/components/flags/flag-catalog'

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

  const byType = summary?.by_type ?? {}
  const chips = FLAG_TYPE_ORDER.filter(type => (byType[type] ?? 0) > 0)
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
      {chips.map(type => (
        <span
          key={type}
          className="flex h-4 min-w-4 items-center justify-center rounded-full text-[10px] text-white font-semibold px-1 leading-none"
          style={{ backgroundColor: FLAG_TYPES[type].color }}
          title={`${FLAG_TYPES[type].label}: ${byType[type]}`}
        >
          {(byType[type] ?? 0) > 99 ? '99+' : byType[type]}
        </span>
      ))}
    </Button>
  )
}

export default FlagsHeaderButton
