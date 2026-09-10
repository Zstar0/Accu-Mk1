import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Flag, Loader2, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getReadyToPublish } from '@/lib/api'
import type { ReadyRow, ReadySla } from '@/lib/api'
import { formatMinutes } from '@/lib/sla-format'
import { useUIStore } from '@/store/ui-store'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  groupByOrder,
  linesText,
  matchesQuery,
  REASON_LABEL,
} from './ready-to-publish-utils'

// ─── Formatting ──────────────────────────────────────────────────────────────

const SLA_TEXT: Record<ReadySla['color'], string> = {
  red: 'text-red-400',
  amber: 'text-amber-400',
  green: 'text-muted-foreground/70',
}
const SLA_DOT: Record<ReadySla['color'], string> = {
  red: 'bg-red-500',
  amber: 'bg-amber-400',
  green: 'bg-emerald-500/70',
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function fmtAge(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`)
  const mins = Math.max(0, (Date.now() - d.getTime()) / 60000)
  return formatMinutes(mins)
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ')
}

// ─── Cells ───────────────────────────────────────────────────────────────────

function SlaCell({ sla }: { sla: ReadySla | null }) {
  if (!sla) {
    return (
      <span className="text-xs text-muted-foreground/50">Awaiting sample</span>
    )
  }
  const text = sla.breached
    ? `${formatMinutes(-sla.remaining_minutes)} over`
    : `${formatMinutes(sla.remaining_minutes)} left`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="rtp-sla"
          data-sla-color={sla.color}
          className={cn(
            'inline-flex items-center gap-1.5 text-xs tabular-nums whitespace-nowrap',
            SLA_TEXT[sla.color]
          )}
        >
          <span
            className={cn('h-2 w-2 rounded-full shrink-0', SLA_DOT[sla.color])}
          />
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="left" className="text-xs">
        <div className="font-medium">{sla.tier}</div>
        <div>Target {formatMinutes(sla.target_minutes)} business time</div>
        <div>Elapsed {formatMinutes(sla.elapsed_minutes)}</div>
      </TooltipContent>
    </Tooltip>
  )
}

function ReasonBadges({ row }: { row: ReadyRow }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {row.reasons.includes('all_verified') && (
        <Badge
          variant="outline"
          className="text-[10px] border-emerald-500/40 text-emerald-400"
          title={`${row.lines.verified}/${row.lines.total} lines verified`}
        >
          {REASON_LABEL.all_verified}
        </Badge>
      )}
      {row.flags.map(f => (
        <Tooltip key={f.id}>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="text-[10px] gap-1"
              style={{ borderColor: f.color, color: f.color }}
              data-testid="rtp-flag"
            >
              <Flag className="h-2.5 w-2.5" />
              {f.label}
              {f.status === 'in_progress' && (
                <span className="opacity-70">· in progress</span>
              )}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            <div className="font-medium">{f.title || f.label}</div>
            <div className="text-muted-foreground">
              Flag #{f.id} · {f.status.replace('_', ' ')}
            </div>
          </TooltipContent>
        </Tooltip>
      ))}
    </span>
  )
}

function SampleLine({
  row,
  indent,
  onOpen,
}: {
  row: ReadyRow
  indent: boolean
  onOpen: (id: string) => void
}) {
  return (
    <tr
      className="border-b border-border/40 hover:bg-muted/30 cursor-pointer"
      data-testid="rtp-row"
      data-sample-id={row.sample_id}
      onClick={() => onOpen(row.sample_id)}
    >
      <td className={cn('py-1.5 pr-2 align-top', indent ? 'pl-8' : 'pl-3')}>
        <div className="font-mono text-sm text-primary">{row.sample_id}</div>
        <div className="text-[11px] text-muted-foreground">
          {!indent && (
            <span className="mr-2 tabular-nums">Order {row.order || '—'}</span>
          )}
          {row.lot ? `Lot ${row.lot}` : 'No lot'}
          {row.priority !== 'normal' && (
            <span className="ml-2 uppercase tracking-wide text-amber-400">
              {row.priority}
            </span>
          )}
        </div>
      </td>
      <td className="py-1.5 pr-2 align-top text-xs">
        {row.analytes.length ? (
          row.analytes.join(', ')
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </td>
      <td className="py-1.5 pr-2 align-top">
        <Badge variant="secondary" className="text-[10px] capitalize">
          {statusLabel(row.status)}
        </Badge>
        <div
          className="text-[11px] text-muted-foreground mt-0.5"
          title={linesText(row.lines)}
        >
          {linesText(row.lines)}
        </div>
      </td>
      <td className="py-1.5 pr-2 align-top">
        <ReasonBadges row={row} />
      </td>
      <td className="py-1.5 pr-2 align-top text-xs tabular-nums whitespace-nowrap">
        {fmtDate(row.received_at)}
        <div className="text-[11px] text-muted-foreground">
          {fmtAge(row.received_at)} ago
        </div>
      </td>
      <td className="py-1.5 pr-3 align-top text-right">
        <SlaCell sla={row.sla} />
      </td>
    </tr>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function ReadyToPublishReport() {
  const [groupByOrderOn, setGroupByOrderOn] = useState(true)
  const [hideTestOrders, setHideTestOrders] = useState(true)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const navigateToSample = useUIStore(state => state.navigateToSample)

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: [
      'reports',
      'ready-to-publish',
      { includeTestOrders: !hideTestOrders },
    ],
    queryFn: () => getReadyToPublish({ includeTestOrders: !hideTestOrders }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  })

  const rows = useMemo(
    () => (data?.rows ?? []).filter(r => matchesQuery(r, query)),
    [data, query]
  )
  const groups = useMemo(() => groupByOrder(rows), [rows])

  const toggle = (order: string) =>
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(order)) next.delete(order)
      else next.add(order)
      return next
    })

  const totals = data?.totals

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold">Ready to Publish</h1>
          <p className="text-xs text-muted-foreground">
            Samples with every line verified, or flagged Ready for Publish /
            Ready for Partial Publish. Most critical first.
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <label className="flex items-center gap-2">
            <Switch
              checked={groupByOrderOn}
              onCheckedChange={setGroupByOrderOn}
            />
            Group by order
          </label>
          <label className="flex items-center gap-2">
            <Switch
              checked={hideTestOrders}
              onCheckedChange={setHideTestOrders}
            />
            Hide test orders
          </label>
          {isFetching && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>

      {totals && (
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant="secondary">{totals.rows} samples</Badge>
          <Badge variant="secondary">{totals.orders} orders</Badge>
          <Badge
            variant="outline"
            className="border-emerald-500/40 text-emerald-400"
          >
            {totals.all_verified} all verified
          </Badge>
          <Badge variant="outline">{totals.flag_ready} flagged ready</Badge>
          <Badge variant="outline">{totals.flag_partial} flagged partial</Badge>
          <Badge
            variant="outline"
            className={cn(
              totals.breached > 0 && 'border-red-500/50 text-red-400'
            )}
          >
            {totals.breached} SLA breached
          </Badge>
        </div>
      )}

      <Input
        placeholder="Filter by order, sample, customer, email, lot or analyte…"
        value={query}
        onChange={e => setQuery(e.target.value)}
        className="max-w-md h-8 text-xs"
      />

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <XCircle className="h-4 w-4" />
          {(error as Error).message}
        </div>
      )}
      {isLoading && !data && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {data && rows.length === 0 && (
        <div className="text-sm text-muted-foreground py-8 text-center">
          Nothing is waiting to be published.
        </div>
      )}

      {rows.length > 0 && (
        <div className="rounded-md border border-border/60 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left py-2 pl-3 pr-2 font-medium">
                  {groupByOrderOn ? 'Order / Sample' : 'Sample'}
                </th>
                <th className="text-left py-2 pr-2 font-medium">Analytes</th>
                <th className="text-left py-2 pr-2 font-medium">
                  Status · Lines
                </th>
                <th className="text-left py-2 pr-2 font-medium">Why</th>
                <th className="text-left py-2 pr-2 font-medium">Received</th>
                <th className="text-right py-2 pr-3 font-medium">SLA</th>
              </tr>
            </thead>
            <tbody>
              {groupByOrderOn
                ? groups.map(g => {
                    const isCollapsed = collapsed.has(g.order)
                    return (
                      <GroupRows
                        key={g.order}
                        group={g}
                        collapsed={isCollapsed}
                        onToggle={() => toggle(g.order)}
                        onOpen={navigateToSample}
                      />
                    )
                  })
                : rows.map(r => (
                    <SampleLine
                      key={r.sample_id}
                      row={r}
                      indent={false}
                      onOpen={navigateToSample}
                    />
                  ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function GroupRows({
  group,
  collapsed,
  onToggle,
  onOpen,
}: {
  group: ReturnType<typeof groupByOrder>[number]
  collapsed: boolean
  onToggle: () => void
  onOpen: (id: string) => void
}) {
  return (
    <>
      <tr
        className="bg-muted/20 border-b border-border/60 cursor-pointer hover:bg-muted/40"
        data-testid="rtp-group"
        data-order={group.order}
        onClick={onToggle}
      >
        <td className="py-2 pl-3 pr-2" colSpan={4}>
          <div className="flex items-center gap-2">
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className="font-semibold tabular-nums">
              Order {group.order}
            </span>
            <span className="text-xs text-muted-foreground truncate">
              {group.client ?? '—'}
              {group.email ? ` · ${group.email}` : ''}
            </span>
            <Badge variant="secondary" className="text-[10px] ml-auto">
              {group.rows.length} sample{group.rows.length === 1 ? '' : 's'}
            </Badge>
          </div>
        </td>
        <td className="py-2 pr-2 text-xs tabular-nums whitespace-nowrap text-muted-foreground">
          Created {fmtDate(group.created_at)}
        </td>
        <td className="py-2 pr-3 text-right">
          {group.worst && (
            <span
              className={cn(
                'inline-flex items-center gap-1.5 text-xs',
                SLA_TEXT[group.worst]
              )}
              title={`${group.breached} breached`}
            >
              <span
                className={cn('h-2 w-2 rounded-full', SLA_DOT[group.worst])}
              />
              {group.breached > 0 ? `${group.breached} breached` : 'on track'}
            </span>
          )}
        </td>
      </tr>
      {!collapsed &&
        group.rows.map(r => (
          <SampleLine key={r.sample_id} row={r} indent onOpen={onOpen} />
        ))}
    </>
  )
}
