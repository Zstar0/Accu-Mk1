import { ChevronDown, ChevronRight } from 'lucide-react'
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
import { TrackingLink } from '@/components/intake/TrackingLink'
import { CustomerNoteCell } from '@/components/intake/CustomerNoteCell'
import type { OrderBoxLabelSummary } from '@/lib/api'

interface OrderListRowProps {
  group: EnrichedOrderGroup
  // Selection state for multi-order combine. The No-order group (orderKey ===
  // null) is not selectable, so its checkbox cell is rendered disabled/empty.
  selected: boolean
  // Gates the per-row checkbox. Defaults true so standalone usage is unchanged;
  // ReceiveSample passes the multi-order check-in flag to hide it when off.
  selectable?: boolean
  // Expanded state lives in the parent (keyed '__none__' for the no-order
  // bucket) so it survives re-sorts and filtering.
  expanded?: boolean
  onToggleExpand?: (key: string) => void
  onToggle: (orderKey: string) => void
  onProcess: (group: EnrichedOrderGroup) => void
  // From the parent's ONE batched box-label-summaries query — never fetched
  // per-row (the per-row fetch melted the DB pool; prod brownout 2026-07-09).
  expectedVialsSummary?: OrderBoxLabelSummary
  expectedVialsLoading?: boolean
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

// Surfaces the order's tracking number, if any sample in the group has one.
// Orders are shipped as one parcel, so the first non-null value stands in for
// the whole order rather than listing per-sample.
function firstTrackedSample(
  group: EnrichedOrderGroup
): EnrichedOrderGroup['samples'][number] | null {
  return group.samples.find(s => Boolean(s.tracking_number)) ?? null
}

// The order's customer note, if any sample in the group carries one. Notes are
// entered per sample in the wizard but are almost always identical across an
// order, so the first one stands in for the group rather than stacking them.
function firstOrderNote(group: EnrichedOrderGroup): string | null {
  return group.samples.find(s => Boolean(s.customer_note))?.customer_note ?? null
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
  expanded = false,
  onToggleExpand,
  onToggle,
  onProcess,
  expectedVialsSummary,
  expectedVialsLoading = false,
}: OrderListRowProps) {
  const order = group.order
  const canSelect = selectable && group.orderKey != null
  const email = order ? getOrderEmail(order) : null
  const customerId = order?.customer_id ?? null
  const linkEmail = email != null && customerId != null
  const expandKey = group.orderKey ?? '__none__'

  const worst = worstSampleState(group)
  const trackedSample = firstTrackedSample(group)
  const orderNote = firstOrderNote(group)

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
      <td className="py-3 px-2 align-middle">
        {onToggleExpand ? (
          <button
            type="button"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.orderLabel}`}
            aria-expanded={expanded}
            onClick={() => onToggleExpand(expandKey)}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        ) : null}
      </td>
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
            <OrderExpectedVials
              summary={expectedVialsSummary}
              loading={expectedVialsLoading}
            />
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
      <td className="py-3 px-3 whitespace-nowrap text-sm">
        {trackedSample ? (
          <TrackingLink
            trackingNumber={trackedSample.tracking_number}
            trackingUrl={trackedSample.tracking_url}
          />
        ) : null}
      </td>
      <td className="py-3 px-3 align-middle">
        <CustomerNoteCell note={orderNote} />
      </td>
      <td className="py-3 px-3 whitespace-nowrap text-right">
        <Button size="sm" onClick={() => onProcess(group)}>
          Process
        </Button>
      </td>
    </tr>
    {expanded && (
      <tr data-testid="order-detail-row" className="bg-muted/20">
        <td colSpan={8} className="px-4 pb-3 pt-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="py-1 pr-4 text-left font-medium w-28">
                  Sample ID
                </th>
                <th className="py-1 pr-4 text-left font-medium">Analytes</th>
                <th className="py-1 pr-4 text-left font-medium w-44">Lot</th>
                <th className="py-1 text-left font-medium w-32">
                  Declared Qty
                </th>
              </tr>
            </thead>
            <tbody>
              {group.samples.map(s => {
                const details =
                  s.analyte_details && s.analyte_details.length > 0
                    ? s.analyte_details
                    : (s.analytes ?? []).map(name => ({
                        name,
                        declared_quantity: null as string | null,
                      }))
                return (
                  <tr key={s.uid} className="border-t border-border/50">
                    <td className="py-1.5 pr-4 font-mono align-top">{s.id}</td>
                    <td className="py-1.5 pr-4 align-top">
                      <span className="flex flex-wrap gap-1">
                        {details.length > 0
                          ? details.map(d => (
                              <span
                                key={d.name}
                                className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs"
                              >
                                {d.name}
                              </span>
                            ))
                          : '—'}
                      </span>
                    </td>
                    <td className="py-1.5 pr-4 font-mono text-xs align-top">
                      {s.client_lot ?? '—'}
                    </td>
                    <td className="py-1.5 text-xs align-top">
                      {details.some(d => d.declared_quantity)
                        ? details
                            .map(d => d.declared_quantity ?? '—')
                            .join(', ')
                        : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </td>
      </tr>
    )}
    </>
  )
}
