import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  STATE_BORDER_CLASS,
  STATE_PRIORITY,
  formatDate,
  getOrderEmail,
} from '@/components/explorer/helpers'
import type { EnrichedOrderGroup } from '@/lib/inbox-orders'
import { customerDetailHash } from '@/lib/inbox-orders'
import { OrderExpectedVials } from '@/components/intake/OrderExpectedVials'

interface OrderListRowProps {
  group: EnrichedOrderGroup
  // Selection state for multi-order combine. The No-order group (orderKey ===
  // null) is not selectable, so its checkbox cell is rendered disabled/empty.
  selected: boolean
  // Gates the per-row checkbox. Defaults true so standalone usage is unchanged;
  // ReceiveSample passes the multi-order check-in flag to hide it when off.
  selectable?: boolean
  onToggle: (orderKey: string) => void
  onProcess: (group: EnrichedOrderGroup) => void
}

// SENAITE review_state → the STATE_PRIORITY key used for the worst-state border.
// Due-receive samples are almost always `sample_due`; map the handful of states
// we expect here so the left border mirrors OrderRow's tint cheaply without a
// full sampleLookupMap.
function normalizeState(reviewState: string | null): string {
  const s = reviewState?.toLowerCase()
  if (!s) return 'sample_due'
  if (s === 'sample_received' || s === 'received') return 'received'
  if (s === 'to_be_verified') return 'to_verify'
  return s
}

function worstSampleState(group: EnrichedOrderGroup): string | null {
  let worst: string | null = null
  let worstPri = Infinity
  for (const sample of group.samples) {
    const key = normalizeState(sample.review_state)
    const pri = STATE_PRIORITY[key] ?? 99
    if (pri < worstPri) {
      worstPri = pri
      worst = key
    }
  }
  return worst
}

/**
 * One order's single-row table item, mirroring `OrderRow` from the Order Status
 * explorer: Order # (with a muted sample-count / expected-vials sub-line), client
 * + linked email + sample-type chips, Created and Process. The left border
 * is tinted by the order's worst sample state.
 */
export function OrderListRow({
  group,
  selected,
  selectable = true,
  onToggle,
  onProcess,
}: OrderListRowProps) {
  const order = group.order
  const canSelect = selectable && group.orderKey != null
  const email = order ? getOrderEmail(order) : null
  const customerId = order?.customer_id ?? null
  const linkEmail = email != null && customerId != null

  const worst = worstSampleState(group)

  const sampleTypes = Array.from(
    new Set(
      group.samples
        .map(s => s.sample_type)
        .filter((t): t is string => Boolean(t))
    )
  )

  return (
    <tr
      data-testid="order-list-row"
      className={cn(
        'align-top border-l-3',
        worst
          ? (STATE_BORDER_CLASS[worst] ?? 'border-l-transparent')
          : 'border-l-transparent'
      )}
    >
      <td className="py-3 px-3 align-middle">
        {canSelect ? (
          <Checkbox
            aria-label={`Select ${group.orderLabel}`}
            checked={selected}
            onCheckedChange={() => onToggle(group.orderKey as string)}
          />
        ) : null}
      </td>
      <td className="py-3 px-3 whitespace-nowrap align-top">
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-sm font-semibold">
            {group.orderLabel}
          </span>
          <span className="text-xs text-muted-foreground">
            {group.samples.length} sample
            {group.samples.length !== 1 ? 's' : ''}{' '}
            <span aria-hidden="true">·</span>{' '}
            <OrderExpectedVials orderNumber={group.orderKey} />
          </span>
        </div>
      </td>
      <td className="py-3 px-3">
        <div className="flex flex-col gap-0.5">
          {group.clientId ? (
            <span className="text-sm">{group.clientId}</span>
          ) : null}
          {email ? (
            linkEmail ? (
              <a
                href={customerDetailHash(customerId)}
                className="text-xs text-primary hover:underline"
                title={email}
              >
                {email}
              </a>
            ) : (
              <span className="text-xs text-muted-foreground" title={email}>
                {email}
              </span>
            )
          ) : null}
          {sampleTypes.length > 0 && (
            <span className="flex flex-wrap gap-1 text-xs">
              {sampleTypes.map(t => (
                <span
                  key={t}
                  className="inline-flex items-center rounded-full border px-2 py-0.5"
                >
                  {t}
                </span>
              ))}
            </span>
          )}
        </div>
      </td>
      <td className="py-3 px-3 whitespace-nowrap text-sm text-muted-foreground">
        {formatDate(order?.created_at ?? null)}
      </td>
      <td className="py-3 px-3 whitespace-nowrap text-right">
        <Button size="sm" onClick={() => onProcess(group)}>
          Process
        </Button>
      </td>
    </tr>
  )
}
