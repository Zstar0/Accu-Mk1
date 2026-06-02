import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Receipt, Tag } from 'lucide-react'

import { getWooOrder } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * Live order-finance disclosure for a customer-detail order row.
 *
 * Fetches the full WooCommerce order on demand (Option A — no IS-side sync) via
 * the existing Mk1 backend proxy `GET /woo/orders/{id}` → `getWooOrder`. Gated on
 * `enabled` so the WC round-trip only fires when the row is expanded; TanStack
 * Query then caches it (5-min staleTime) so collapse/re-expand is free and
 * multiple rows don't refetch on every render.
 *
 * The WC payload that lands in `order_submissions.payload` does NOT carry order
 * finance (only per-sample `prices`), so this is sourced live from WC rather
 * than from the IS database.
 */

/**
 * Decode WC `currency_symbol`, which arrives as a numeric HTML entity
 * (e.g. "&#36;" → "$", "&#8364;" → "€"). XSS-safe: only numeric/hex character
 * references are converted via String.fromCodePoint — no innerHTML, no DOM, so
 * no markup is ever parsed or executed. Literal symbols pass through unchanged.
 */
function decodeEntity(s: string): string {
  if (!s) return s
  return s.replace(/&#(x?[0-9a-f]+);/gi, (_match, code: string) => {
    const cp = code.toLowerCase().startsWith('x')
      ? parseInt(code.slice(1), 16)
      : parseInt(code, 10)
    return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : ''
  })
}

function money(amount: string | number, symbol: string): string {
  const n = typeof amount === 'number' ? amount : parseFloat(amount || '0')
  if (Number.isNaN(n)) return '—'
  return `${symbol}${n.toFixed(2)}`
}

function FinanceRow({
  label,
  value,
  emphasis,
  muted,
}: {
  label: React.ReactNode
  value: string
  emphasis?: boolean
  muted?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-4 py-1',
        emphasis && 'border-t border-border/60 pt-2 mt-1 font-semibold'
      )}
    >
      <span className={cn('text-sm', muted && 'text-muted-foreground')}>
        {label}
      </span>
      <span
        className={cn(
          'font-mono text-sm tabular-nums',
          muted && 'text-muted-foreground'
        )}
      >
        {value}
      </span>
    </div>
  )
}

export function OrderFinancePanel({
  orderId,
  enabled,
}: {
  orderId: string
  enabled: boolean
}) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['wooOrder', orderId],
    queryFn: () => getWooOrder(orderId),
    enabled,
    staleTime: 5 * 60 * 1000,
  })

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="h-4 w-full max-w-sm" />
        <Skeleton className="h-4 w-32" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>
          Couldn&apos;t load finance details
          {error instanceof Error ? `: ${error.message}` : ''}. WooCommerce may
          be unreachable.
        </span>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No matching WooCommerce order found (it may not be synced yet).
      </div>
    )
  }

  const sym = decodeEntity(data.currency_symbol || '') || data.currency || '$'
  const subtotal = data.line_items.reduce(
    (acc, li) => acc + parseFloat(li.subtotal || '0'),
    0
  )
  const discount = parseFloat(data.discount_total || '0')
  const shipping = parseFloat(data.shipping_total || '0')
  const tax = parseFloat(data.total_tax || '0')
  const paidDate = data.date_paid
    ? new Date(data.date_paid).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null

  return (
    <div className="grid gap-6 p-4 md:grid-cols-2">
      {/* Left: line items + meta */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Receipt className="h-3.5 w-3.5" />
          Line items
        </div>
        {data.line_items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No line items.</p>
        ) : (
          <ul className="space-y-1.5">
            {data.line_items.map(li => (
              <li
                key={li.id}
                className="flex items-baseline justify-between gap-4 text-sm"
              >
                <span className="truncate" title={li.name}>
                  {li.name}
                  {li.quantity > 1 && (
                    <span className="text-muted-foreground">
                      {' '}
                      × {li.quantity}
                    </span>
                  )}
                </span>
                <span className="font-mono tabular-nums">
                  {money(li.total, sym)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Badge variant="outline" className="capitalize">
            {data.status}
          </Badge>
          {data.payment_method_title && (
            <span className="text-xs text-muted-foreground">
              {data.payment_method_title}
              {paidDate ? ` · paid ${paidDate}` : ''}
            </span>
          )}
        </div>
      </div>

      {/* Right: totals */}
      <div className="md:border-l md:border-border/60 md:pl-6">
        <FinanceRow label="Subtotal" value={money(subtotal, sym)} muted />
        {discount > 0 && (
          <FinanceRow
            label={
              <span className="flex flex-wrap items-center gap-1.5">
                Discount
                {data.coupon_lines.map(c => (
                  <Badge
                    key={c.id}
                    variant="secondary"
                    className="gap-1 font-mono text-[10px]"
                  >
                    <Tag className="h-2.5 w-2.5" />
                    {c.code}
                  </Badge>
                ))}
              </span>
            }
            value={`−${money(discount, sym)}`}
            muted
          />
        )}
        {shipping > 0 && (
          <FinanceRow label="Shipping" value={money(shipping, sym)} muted />
        )}
        <FinanceRow label="Tax" value={money(tax, sym)} muted />
        <FinanceRow
          label={`Total (${data.currency})`}
          value={money(data.total, sym)}
          emphasis
        />
      </div>
    </div>
  )
}
