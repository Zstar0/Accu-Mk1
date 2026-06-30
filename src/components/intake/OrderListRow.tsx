import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type { OrderSlaVerdict } from '@/lib/sla-resolution'
import { OrderSlaCell } from '@/components/explorer/OrderSlaCell'
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
  // From useOrderSlaStatuses (wired in Task 1.5). Undefined → the SLA cell
  // renders its inert "awaiting"/loading state.
  slaVerdict?: OrderSlaVerdict
  // Selection state for multi-order combine. The No-order group (orderKey ===
  // null) is not selectable, so its checkbox cell is rendered disabled/empty.
  selected: boolean
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
 * One order's 2-row table item, mirroring `OrderRow` from the Order Status
 * explorer: a primary row (Order #, client + linked email, Created, SLA,
 * Process) over a muted secondary row (sample count, expected vials, sample-type
 * chips). The left border is tinted by the order's worst sample state.
 */
export function OrderListRow({
  group,
  slaVerdict,
  selected,
  onToggle,
  onProcess,
}: OrderListRowProps) {
  const order = group.order
  const selectable = group.orderKey != null
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
    <>
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
          {selectable ? (
            <Checkbox
              aria-label={`Select ${group.orderLabel}`}
              checked={selected}
              onCheckedChange={() => onToggle(group.orderKey as string)}
            />
          ) : null}
        </td>
        <td className="py-3 px-3 whitespace-nowrap font-mono text-sm font-semibold">
          {group.orderLabel}
        </td>
        <td className="py-3 px-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm">{group.clientId ?? '—'}</span>
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
            ) : (
              <span className="text-xs text-muted-foreground">{'—'}</span>
            )}
          </div>
        </td>
        <td className="py-3 px-3 whitespace-nowrap text-sm text-muted-foreground">
          {formatDate(order?.created_at ?? null)}
        </td>
        <td className="py-3 px-3 whitespace-nowrap align-top">
          <OrderSlaCell
            verdict={slaVerdict ?? { color: 'awaiting' }}
            isLoading={!slaVerdict}
          />
        </td>
        <td className="py-3 px-3 whitespace-nowrap text-right">
          <Button size="sm" onClick={() => onProcess(group)}>
            Process
          </Button>
        </td>
      </tr>
      <tr>
        <td
          colSpan={6}
          className="pb-3 px-3 text-xs text-muted-foreground border-l-3 border-l-transparent"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              {group.samples.length} sample
              {group.samples.length !== 1 ? 's' : ''}
            </span>
            <span aria-hidden="true">·</span>
            <OrderExpectedVials orderNumber={group.orderKey} />
            {sampleTypes.length > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="flex flex-wrap gap-1">
                  {sampleTypes.map(t => (
                    <span
                      key={t}
                      className="inline-flex items-center rounded-full border px-2 py-0.5"
                    >
                      {t}
                    </span>
                  ))}
                </span>
              </>
            )}
          </div>
        </td>
      </tr>
    </>
  )
}
