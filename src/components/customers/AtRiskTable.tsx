import { cn } from '@/lib/utils'
import type { AtRiskRow } from '@/lib/api'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { fmtMoney } from './insights-utils'
import { TouchCell } from './TouchCell'
import type { useTouchpoints } from './useTouchpoints'

/** The At risk tab's table. Every row opens the customer (wc: keys get the full
 *  detail, guest email: keys the Dashboard-only detail); the row's hover card
 *  hangs off the name cell so it never stacks with the touch cells' own cards.
 *  The two touch columns render only when the server made them visible. */
export function AtRiskTable({
  rows,
  tz,
  touch,
  onOpenCustomer,
}: {
  rows: AtRiskRow[]
  tz: string
  touch: ReturnType<typeof useTouchpoints>
  onOpenCustomer: (key: string, tab?: 'crm' | 'support') => void
}) {
  return (
    <table className="w-full text-sm tabular-nums">
      <thead>
        <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
          <th className="py-1 text-start font-medium">Customer</th>
          <th className="text-start font-medium">Rep</th>
          <th className="text-end font-medium">12-mo spend</th>
          <th className="text-end font-medium">Orders</th>
          <th className="text-end font-medium">Usual gap</th>
          <th className="text-end font-medium">Last order</th>
          <th className="text-end font-medium">Overdue</th>
          {touch.crmVisible && (
            <th className="px-2 text-end font-medium">Last CRM</th>
          )}
          {touch.supportVisible && (
            <th className="px-2 text-end font-medium">Last support</th>
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <td className="py-1.5 font-medium" tabIndex={0}>
                    {r.name}
                  </td>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs p-0">
                  <div className="flex flex-col gap-1.5 p-3 font-mono text-xs">
                    <div className="border-b border-primary-foreground/20 pb-1.5 font-semibold">
                      {r.name}
                    </div>
                    <div>{r.email ?? 'no email'}</div>
                    <div>Rep: {r.rep ?? 'unassigned'}</div>
                    <div>
                      Usual gap{' '}
                      {r.usual_gap_days == null
                        ? 'n/a'
                        : `${r.usual_gap_days} d`}
                      {' · '}last order{' '}
                      {r.last_order_at ? r.last_order_at.slice(0, 10) : 'n/a'}
                    </div>
                    <div className="border-t border-primary-foreground/20 pt-1.5">
                      Lifetime {fmtMoney(r.lifetime)} · {r.samples} samples
                    </div>
                    <div>Top tests: {r.top_tests.join(', ') || 'n/a'}</div>
                  </div>
                </TooltipContent>
              </Tooltip>
              <td className="text-muted-foreground">{r.rep ?? 'Unassigned'}</td>
              <td className="text-end">{fmtMoney(r.spend_12m)}</td>
              <td className="text-end">{r.orders}</td>
              <td className="text-end">
                {r.usual_gap_days == null ? 'n/a' : `${r.usual_gap_days} d`}
              </td>
              <td className="text-end">
                {r.last_order_at
                  ? new Date(r.last_order_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      timeZone: tz,
                    })
                  : ''}
              </td>
              <td className="text-end">
                <span
                  className={cn(
                    'rounded-full px-2 text-xs font-semibold',
                    r.overdue >= 3
                      ? 'bg-red-500/15 text-red-700 dark:text-red-300'
                      : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                  )}
                >
                  {r.overdue}× gap
                </span>
              </td>
              {touch.crmVisible && (
                <td className="px-2 text-end">
                  <TouchCell
                    kind="crm"
                    touch={tp ? (tp.crm ?? null) : undefined}
                    tz={tz}
                    onOpen={() => onOpenCustomer(r.key, 'crm')}
                  />
                </td>
              )}
              {touch.supportVisible && (
                <td className="px-2 text-end">
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
  )
}
