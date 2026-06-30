import { Flag } from 'lucide-react'
import type { CSSProperties } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'
import { useEntityFlags } from '@/hooks/use-flags'
import { flagTypeDef } from '@/components/flags/flag-catalog'
import { useFlagTypesMap } from '@/services/flag-types'
import { formatDateTime } from '@/components/flags/flag-format'
import { RaiseFlagButton } from '@/components/flags/RaiseFlagButton'
import type { FlagResponse } from '@/lib/flags-api'

/**
 * Stateful flag affordance for an entity page (sample / vial / worksheet).
 *
 * - **Unflagged** → a subtle outline "Flag" button that opens the raise-flag
 *   compose (reusing {@link RaiseFlagButton}) prefilled with this entity.
 * - **Flagged** → a bold, filled, type-colored pill that pulls the eye (the
 *   dominant open flag's color, a count when >1, a soft type-colored glow).
 *   Click: exactly one open flag → open its thread; more than one → open the
 *   flyout filtered to this entity.
 *
 * Open = `open` | `in_progress` (the states that still want attention). The
 * `sample` button passes `includeDescendants` so it aggregates its vials.
 */

const OPEN_STATES = new Set(['open', 'in_progress'])

// Dominant-severity order for the pill color when several types are open
// (blocker is the loudest). Distinct from the catalog's display order.
const SEVERITY_ORDER: string[] = [
  'blocker',
  'critical',
  'waiting_on_customer',
  'question',
  'ready_for_verification',
]

function severityRank(type: string): number {
  const i = SEVERITY_ORDER.indexOf(type)
  return i === -1 ? SEVERITY_ORDER.length : i
}

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

/** The most recently updated flag — drives the "status · last update" subline.
 *  Backend timestamps share one ISO format, so a string compare orders them. */
function latestFlag(open: FlagResponse[]): FlagResponse | undefined {
  return open.reduce<FlagResponse | undefined>(
    (best, f) => (!best || f.updated_at > best.updated_at ? f : best),
    undefined
  )
}

/** The most severe open flag — drives the pill's color. Undefined only for an
 *  empty list (callers guard before rendering the pill). */
function dominantFlag(open: FlagResponse[]): FlagResponse | undefined {
  return open.reduce<FlagResponse | undefined>(
    (best, f) =>
      !best || severityRank(f.type) < severityRank(best.type) ? f : best,
    undefined
  )
}

export interface EntityFlagButtonProps {
  entityType: string
  entityId: string
  /** Roll up descendant flags (a sample aggregating its vials). */
  includeDescendants?: boolean
  /** `lg` is the attention-catching size for primary page headers. */
  size?: 'md' | 'lg'
  className?: string
}

export function EntityFlagButton({
  entityType,
  entityId,
  includeDescendants = false,
  size = 'md',
  className,
}: EntityFlagButtonProps) {
  const { data } = useEntityFlags(entityType, entityId, { includeDescendants })
  const typesMap = useFlagTypesMap()
  const open = (data ?? []).filter(f => OPEN_STATES.has(f.status))
  const lg = size === 'lg'

  // --- Unflagged: subtle outline affordance → raise compose --------------
  if (open.length === 0) {
    return (
      <RaiseFlagButton
        entityType={entityType}
        entityId={entityId}
        trigger={
          <Button
            variant="outline"
            size={lg ? 'default' : 'sm'}
            aria-label="Raise a flag on this item"
            className={cn(
              'gap-1.5 text-muted-foreground hover:text-foreground',
              lg && 'h-9 px-3.5',
              className
            )}
          >
            <Flag className={cn(lg ? 'h-4 w-4' : 'h-3.5 w-3.5')} />
            Flag
          </Button>
        }
      />
    )
  }

  // --- Flagged: bold, type-colored pill ----------------------------------
  const dominant = dominantFlag(open)
  if (!dominant) return null // unreachable (open is non-empty) — narrows the type
  const def = typesMap[dominant.type] ?? flagTypeDef(dominant.type)
  const count = open.length
  const latest = latestFlag(open) ?? dominant
  const subline = `${statusLabel(latest.status)} · ${formatDateTime(latest.updated_at)}`
  const label =
    count === 1
      ? `Flag (${def.label}) — ${subline}. Open it.`
      : `${count} open flags — latest ${subline}. View all.`

  const handleClick = () => {
    const [first] = open
    if (count === 1 && first) {
      useUIStore.getState().openFlagThread(first.id)
    } else {
      useUIStore
        .getState()
        .openFlagsForEntity(entityType, entityId, { includeDescendants })
    }
  }

  return (
    <Button
      type="button"
      onClick={handleClick}
      aria-label={label}
      title={label}
      style={
        {
          backgroundColor: def.color,
          '--flag-glow-color': def.color,
        } as CSSProperties
      }
      className={cn(
        'flags-entity-glow h-auto items-center gap-2 border-0 py-1.5 font-bold text-white shadow-sm transition-transform hover:brightness-110 active:scale-95',
        lg ? 'px-3.5' : 'px-2.5',
        className
      )}
    >
      <Flag
        className={cn('shrink-0', lg ? 'h-4 w-4' : 'h-3.5 w-3.5')}
        fill="currentColor"
      />
      <span className="flex flex-col items-start leading-tight">
        <span
          className={cn(
            'flex items-center gap-1.5',
            lg ? 'text-sm' : 'text-xs'
          )}
        >
          Flagged
          {count > 1 && (
            <span
              className={cn(
                'flex h-4 min-w-4 items-center justify-center rounded-full bg-white/25 px-1 font-semibold leading-none',
                lg ? 'text-[11px]' : 'text-[10px]'
              )}
            >
              {count > 99 ? '99+' : count}
            </span>
          )}
        </span>
        <span
          className={cn(
            'font-normal text-white/85',
            lg ? 'text-[11px]' : 'text-[10px]'
          )}
        >
          {subline}
        </span>
      </span>
    </Button>
  )
}

export default EntityFlagButton
