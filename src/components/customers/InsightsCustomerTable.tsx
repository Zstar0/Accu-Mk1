import { ArrowDown, ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CustomerRow } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { fmtMoney, STATUS_CLASS, STATUS_LABEL } from './insights-utils'
import { TouchCell } from './TouchCell'
import type { useTouchpoints } from './useTouchpoints'

export type InsightsSortField =
  | 'name'
  | 'company'
  | 'rep'
  | 'first_order_at'
  | 'testing_orders'
  | 'lifetime'
  | 'last_order_at'
  | 'status'

const COLUMNS: { field: InsightsSortField; label: string; right?: boolean }[] =
  [
    { field: 'name', label: 'Customer' },
    { field: 'company', label: 'Company' },
    { field: 'rep', label: 'Rep' },
    { field: 'first_order_at', label: 'First order', right: true },
    { field: 'testing_orders', label: 'Testing orders', right: true },
    { field: 'lifetime', label: 'Lifetime', right: true },
    { field: 'last_order_at', label: 'Last order', right: true },
    { field: 'status', label: 'Status' },
  ]

const fmtDate = (iso: string | null, tz: string) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: tz,
      })
    : ''

export function InsightsCustomerTable({
  rows,
  total,
  page,
  pageSize,
  onPage,
  sort,
  dir,
  onSort,
  tz,
  touch,
  onOpenCustomer,
  emptyText,
}: {
  rows: CustomerRow[]
  total: number
  page: number
  pageSize: number
  onPage: (p: number) => void
  sort: InsightsSortField
  dir: 'asc' | 'desc'
  onSort: (f: InsightsSortField) => void
  tz: string
  touch: ReturnType<typeof useTouchpoints>
  onOpenCustomer: (key: string, tab?: 'crm' | 'support') => void
  emptyText: string
}) {
  if (rows.length === 0)
    return (
      <p className="py-4 text-center text-sm text-muted-foreground">
        {emptyText}
      </p>
    )
  const start = (page - 1) * pageSize + 1
  const end = start + rows.length - 1
  return (
    <>
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {COLUMNS.map(c => (
              <th
                key={c.field}
                className={cn(
                  'py-1 font-medium',
                  c.right ? 'text-right' : 'text-left'
                )}
              >
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-0.5 uppercase tracking-wider hover:text-foreground"
                  onClick={() => onSort(c.field)}
                >
                  {c.label}
                  {sort === c.field &&
                    (dir === 'asc' ? (
                      <ArrowUp className="h-3 w-3" />
                    ) : (
                      <ArrowDown className="h-3 w-3" />
                    ))}
                </button>
              </th>
            ))}
            {touch.crmVisible && (
              <th className="text-right font-medium">Last CRM</th>
            )}
            {touch.supportVisible && (
              <th className="text-right font-medium">Last support</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const tp = touch.rows[r.key]
            return (
              <tr
                key={r.key}
                className="cursor-pointer border-t border-border/20 hover:bg-muted/30"
                tabIndex={0}
                onClick={() => onOpenCustomer(r.key)}
                onKeyDown={e => {
                  if (e.key === 'Enter') onOpenCustomer(r.key)
                }}
              >
                <td className="py-1.5 font-medium">{r.name}</td>
                <td className="text-muted-foreground">{r.company ?? ''}</td>
                <td className="text-muted-foreground">
                  {r.rep ?? 'Unassigned'}
                </td>
                <td className="text-right">{fmtDate(r.first_order_at, tz)}</td>
                <td className="text-right">{r.testing_orders}</td>
                <td className="text-right">{fmtMoney(r.lifetime)}</td>
                <td className="text-right">{fmtDate(r.last_order_at, tz)}</td>
                <td>
                  <span
                    className={cn(
                      'rounded-full px-2 text-xs font-semibold',
                      STATUS_CLASS[r.status]
                    )}
                  >
                    {STATUS_LABEL[r.status] ?? r.status}
                  </span>
                </td>
                {touch.crmVisible && (
                  <td className="text-right">
                    <TouchCell
                      kind="crm"
                      touch={tp ? (tp.crm ?? null) : undefined}
                      tz={tz}
                      onOpen={() => onOpenCustomer(r.key, 'crm')}
                    />
                  </td>
                )}
                {touch.supportVisible && (
                  <td className="text-right">
                    <TouchCell
                      kind="support"
                      touch={tp ? (tp.support ?? null) : undefined}
                      tz={tz}
                      onOpen={() => onOpenCustomer(r.key, 'support')}
                    />
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{`${start}–${end} of ${total}`}</span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={end >= total}
            onClick={() => onPage(page + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </>
  )
}
