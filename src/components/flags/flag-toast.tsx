/**
 * Rich toast body for a flag ping. The event's `FlagSnapshot` carries enough to
 * render a legible summary without opening the flyout: the flag title over a
 * compact Entity · Type · Status meta line (entity icon + label, type with its
 * catalog color, status with its lifecycle dot). Mirrors the card meta row.
 *
 * Lives in its own `.tsx` because the SSE glue that raises toasts is a `.ts`
 * module (no JSX); it imports this and passes the node as sonner's `description`.
 */
import { entityMeta, entityLabel } from '@/components/flags/flag-entity'
import { STATUS_LABELS, STATUS_DOT } from '@/components/flags/flag-status'
import type { FlagTypeDef } from '@/components/flags/flag-catalog'
import type { FlagSnapshot } from '@/lib/flag-stream'
import type { FlagStatus } from '@/lib/flags-api'

export function flagToastBody(flag: FlagSnapshot, def: FlagTypeDef) {
  const { Icon } = entityMeta(flag.entity_type)
  const entity = entityLabel(flag.entity_type, flag.entity_id)
  const status = flag.status as FlagStatus
  const statusLabel = STATUS_LABELS[status] ?? flag.status
  const statusColor = STATUS_DOT[status] ?? '#94a3b8'

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-foreground">{flag.title}</span>
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium text-foreground/80">
          <Icon className="h-3 w-3 shrink-0" />
          {entity}
        </span>
        <span aria-hidden>·</span>
        <span className="inline-flex items-center gap-1">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: def.color }}
            aria-hidden
          />
          {def.label}
        </span>
        <span aria-hidden>·</span>
        <span className="inline-flex items-center gap-1">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: statusColor }}
            aria-hidden
          />
          {statusLabel}
        </span>
      </span>
    </div>
  )
}
