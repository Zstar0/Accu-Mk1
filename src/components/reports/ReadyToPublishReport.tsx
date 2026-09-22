import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Flag,
  Loader2,
  PauseCircle,
  PlayCircle,
  XCircle,
} from 'lucide-react'
import { fmtWhen, isParkedSchedule } from '@/lib/scheduled-publish'
import { cn } from '@/lib/utils'
import { getReadyToPublish } from '@/lib/api'
import type { ReadyRow, ReadySla } from '@/lib/api'
import { changeStatus } from '@/lib/flags-api'
import { useCreateFlag } from '@/hooks/use-flags'
import { formatMinutes, tierDayMinutes } from '@/lib/sla-format'
import { useBusinessDayMinutes } from '@/services/business-hours'
import { useUIStore } from '@/store/ui-store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { PriorityGlyph } from '@/components/common/PriorityGlyph'
import { FlagIndicator } from '@/components/flags/FlagIndicator'
import { SlaBreakdownTooltip } from '@/components/explorer/SlaBreakdownTooltip'
import { STATE_LABELS } from '@/components/senaite/senaite-utils'
import { useStateLabel } from '@/lib/workflow-states-store'
import type { InboxPriority, SlaTier } from '@/lib/api'
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
  sortRows,
  splitHeld,
  type ReadySort,
  type ReadySortKey,
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

const REPORT_KEY = ['reports', 'ready-to-publish'] as const

function toDate(iso: string): Date {
  return new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`)
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = toDate(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function fmtAge(iso: string | null): string {
  if (!iso) return '—'
  const mins = Math.max(0, (Date.now() - toDate(iso).getTime()) / 60000)
  return formatMinutes(mins)
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ')
}

/** The partial-publish state: primary COA out, add-on lines pending. */
const PARTIAL_STATE = 'waiting_for_addon_results'

// ─── Cells ───────────────────────────────────────────────────────────────────

/** The report's SLA block reshaped into the shared breakdown card's inputs.
 *  The report has no client-side resolver snapshot, so `reason` is null; the
 *  card still shows received, tier, target, elapsed and remaining exactly as
 *  the Order Status page does (memory: feedback_sla_hover_breakdown_everywhere). */
function tierFromSla(sla: ReadySla, day_minutes?: number): SlaTier {
  return {
    id: 0,
    name: sla.tier,
    target_minutes: sla.target_minutes,
    business_hours_only: sla.business_hours_only,
    is_default: false,
    amber_threshold_percent: 0,
    created_at: '',
    updated_at: '',
    day_minutes,
  }
}

export function SlaCell({ row }: { row: ReadyRow }) {
  const sla = row.sla
  const dayMinutes = useBusinessDayMinutes()
  if (!sla) {
    return (
      <span className="text-xs text-muted-foreground/50">Awaiting sample</span>
    )
  }
  const tier = tierFromSla(sla, dayMinutes)
  const day = tierDayMinutes(tier)
  const text = sla.breached
    ? `${formatMinutes(-sla.remaining_minutes, day)} over`
    : `${formatMinutes(sla.remaining_minutes, day)} left`
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
      <TooltipContent side="left" className="p-0 max-w-md">
        <SlaBreakdownTooltip
          tier={tier}
          status={{
            target_minutes: sla.target_minutes,
            elapsed_minutes: sla.elapsed_minutes,
            remaining_minutes: sla.remaining_minutes,
            breached: sla.breached,
          }}
          reason={null}
          priority={row.priority as InboxPriority}
          receivedAt={row.received_at}
        />
      </TooltipContent>
    </Tooltip>
  )
}

export function ReasonBadges({ row }: { row: ReadyRow }) {
  const partialLabel = useStateLabel(
    PARTIAL_STATE,
    STATE_LABELS[PARTIAL_STATE]?.label ?? 'Partially Published'
  )
  return (
    <span className="inline-flex flex-wrap gap-1">
      {row.status === PARTIAL_STATE && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="text-[10px] border-indigo-400/40 text-indigo-300"
              data-testid="rtp-partial"
            >
              {partialLabel}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {row.lines.pending.length
              ? 'Primary COA is out; add-on results still pending.'
              : 'Primary COA is out and the add-on results are in. Publish again to regenerate.'}
          </TooltipContent>
        </Tooltip>
      )}
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

interface RowActions {
  onOpen: (id: string) => void
  /** Undefined when no "On Hold" flag type exists yet. */
  onHold?: (row: ReadyRow) => void
  onRelease?: (row: ReadyRow) => void
  busyId?: string | null
}

function SampleLine({
  row,
  indent,
  actions,
}: {
  row: ReadyRow
  indent: boolean
  actions: RowActions
}) {
  const held = row.hold !== null
  const busy = actions.busyId === row.sample_id
  const statusText = useStateLabel(
    row.status,
    STATE_LABELS[row.status]?.label ?? statusLabel(row.status)
  )
  return (
    <tr
      className={cn(
        'border-b border-border/40 hover:bg-muted/30 cursor-pointer',
        held && 'opacity-80'
      )}
      data-testid="rtp-row"
      data-sample-id={row.sample_id}
      data-held={held ? 'true' : undefined}
      onClick={() => actions.onOpen(row.sample_id)}
    >
      <td className={cn('py-1.5 pr-2 align-top', indent ? 'pl-8' : 'pl-3')}>
        <div className="font-mono text-sm text-primary inline-flex items-center gap-1.5">
          {row.sample_id}
          {/* Same glyph as the samples list / inbox; renders nothing on the
              default priority. */}
          <PriorityGlyph priority={row.effective_priority} size="row" />
        </div>
        <div className="text-[11px] text-muted-foreground">
          {!indent && (
            <span className="mr-2 tabular-nums">Order {row.order || '—'}</span>
          )}
          {row.lot ? `Lot ${row.lot}` : 'No lot'}
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
          {statusText}
        </Badge>
        {/* Bounded so a long pending list (native keywords since 1.21.2) cannot
            widen this auto-layout column and push Why away; full text on hover. */}
        <div
          className="text-[11px] text-muted-foreground mt-0.5 max-w-56 truncate"
          title={linesText(row.lines)}
        >
          {linesText(row.lines)}
        </div>
      </td>
      <td className="py-1.5 pr-2 align-top">
        {held && row.hold ? (
          <div className="text-xs">
            <Badge
              variant="outline"
              className="text-[10px] gap-1"
              style={{ borderColor: row.hold.color, color: row.hold.color }}
              data-testid="rtp-hold"
            >
              <PauseCircle className="h-2.5 w-2.5" />
              {row.hold.label}
            </Badge>
            <div className="text-muted-foreground mt-0.5">
              {row.hold.title || 'No reason given'}
              {row.hold.since ? ` · since ${fmtDate(row.hold.since)}` : ''}
            </div>
          </div>
        ) : isParkedSchedule(row.scheduled) && row.scheduled ? (
          <div className="text-xs">
            <Badge
              variant="outline"
              className="text-[10px] gap-1 border-sky-500/50 text-sky-400"
              data-testid="rtp-scheduled"
            >
              <CalendarClock className="h-2.5 w-2.5" />
              {row.scheduled.status === 'firing'
                ? 'Publishing now'
                : `Publishes ${fmtWhen(row.scheduled.scheduled_at)}`}
            </Badge>
            <div className="text-muted-foreground mt-0.5">
              COA date {row.scheduled.pdf_date}
            </div>
          </div>
        ) : (
          <>
            {row.scheduled?.status === 'failed' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="text-[10px] gap-1 border-red-500/50 text-red-400 mb-0.5"
                    data-testid="rtp-scheduled-failed"
                  >
                    <CalendarClock className="h-2.5 w-2.5" />
                    Scheduled publish failed
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-xs">
                  {row.scheduled.last_error ?? 'No error recorded'}
                </TooltipContent>
              </Tooltip>
            )}
            <ReasonBadges row={row} />
          </>
        )}
      </td>
      <td className="py-1.5 pr-2 align-top text-xs tabular-nums whitespace-nowrap">
        {fmtDate(row.received_at)}
        <div className="text-[11px] text-muted-foreground">
          {fmtAge(row.received_at)} ago
        </div>
      </td>
      <td className="py-1.5 pr-2 align-top text-right">
        <SlaCell row={row} />
      </td>
      <td className="py-1.5 pr-2 align-top" data-testid="rtp-flags">
        {/* All open flags on the sample, coloured by the dominant type; click
            opens the flags flyout (the indicator stops row-click propagation). */}
        <FlagIndicator scope={{ kind: 'sample', sampleId: row.sample_id }} />
      </td>
      <td className="py-1.5 pr-3 align-top text-right whitespace-nowrap">
        {held ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={!actions.onRelease || busy}
            onClick={e => {
              e.stopPropagation()
              actions.onRelease?.(row)
            }}
            data-testid="rtp-release"
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <PlayCircle className="h-3 w-3" />
            )}
            Release
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  disabled={!actions.onHold || busy}
                  onClick={e => {
                    e.stopPropagation()
                    actions.onHold?.(row)
                  }}
                  data-testid="rtp-hold-btn"
                >
                  {busy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <PauseCircle className="h-3 w-3" />
                  )}
                  Hold
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">
              {actions.onHold
                ? 'Raise an On Hold flag on this sample and park it below.'
                : 'Create an "On Hold" flag type in Settings → Flags first.'}
            </TooltipContent>
          </Tooltip>
        )}
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
  const [showHeld, setShowHeld] = useState(false)
  const [showScheduled, setShowScheduled] = useState(false)
  // null = the backend's "most critical first"; a header click sorts that column.
  const [sort, setSort] = useState<ReadySort | null>(null)
  const toggleSort = (key: ReadySortKey) =>
    setSort(s =>
      s?.key !== key
        ? { key, dir: 'asc' }
        : s.dir === 'asc'
          ? { key, dir: 'desc' }
          : null
    )
  const [busyId, setBusyId] = useState<string | null>(null)
  const navigateToSample = useUIStore(state => state.navigateToSample)
  const qc = useQueryClient()

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: [...REPORT_KEY, { includeTestOrders: !hideTestOrders }],
    queryFn: () => getReadyToPublish({ includeTestOrders: !hideTestOrders }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  })

  const holdSlug = useMemo(
    () => data?.flag_types.find(t => t.kind === 'hold')?.slug ?? null,
    [data]
  )

  const createFlag = useCreateFlag()
  const releaseHold = useMutation({
    mutationFn: (flagId: number) => changeStatus(flagId, 'resolved'),
  })

  const refresh = () => qc.invalidateQueries({ queryKey: REPORT_KEY })

  const onHold = holdSlug
    ? async (row: ReadyRow) => {
        const reason = window.prompt(
          `Put ${row.sample_id} on hold — reason (shown on this page):`,
          ''
        )
        if (reason === null) return
        setBusyId(row.sample_id)
        try {
          await createFlag.mutateAsync({
            entity_type: 'sample',
            entity_id: row.sample_id,
            type: holdSlug,
            title: reason.trim() || 'On hold',
          })
          await refresh()
        } finally {
          setBusyId(null)
        }
      }
    : undefined

  const onRelease = async (row: ReadyRow) => {
    if (!row.hold) return
    setBusyId(row.sample_id)
    try {
      await releaseHold.mutateAsync(row.hold.flag_id)
      await refresh()
    } finally {
      setBusyId(null)
    }
  }

  const filtered = useMemo(
    () => (data?.rows ?? []).filter(r => matchesQuery(r, query)),
    [data, query]
  )
  const sorted = useMemo(() => sortRows(filtered, sort), [filtered, sort])
  const { live, held, scheduled } = useMemo(() => splitHeld(sorted), [sorted])
  const groups = useMemo(() => groupByOrder(live), [live])

  const toggle = (order: string) =>
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(order)) next.delete(order)
      else next.add(order)
      return next
    })

  const totals = data?.totals
  const actions: RowActions = {
    onOpen: navigateToSample,
    onHold,
    onRelease,
    busyId,
  }

  const header = (
    <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
      <tr>
        {(
          [
            [
              'sample',
              groupByOrderOn ? 'Order / Sample' : 'Sample',
              'text-left pl-3',
            ],
            ['analytes', 'Analytes', 'text-left'],
            ['status', 'Status · Lines', 'text-left'],
            ['why', 'Why', 'text-left'],
            ['received', 'Received', 'text-left'],
            ['sla', 'SLA', 'text-right'],
          ] as const
        ).map(([key, label, align]) => (
          <th
            key={key}
            className={`${align} py-2 pr-2 font-medium`}
            aria-sort={
              sort?.key === key
                ? sort.dir === 'asc'
                  ? 'ascending'
                  : 'descending'
                : 'none'
            }
          >
            <button
              type="button"
              className="inline-flex items-center gap-1 uppercase hover:text-foreground"
              title={
                sort?.key === key
                  ? 'Click again to flip; a third click restores most-critical-first'
                  : `Sort by ${label}`
              }
              onClick={() => toggleSort(key)}
            >
              {label}
              {sort?.key === key ? (
                sort.dir === 'asc' ? (
                  <ArrowUp className="h-3 w-3" />
                ) : (
                  <ArrowDown className="h-3 w-3" />
                )
              ) : (
                <ArrowUpDown className="h-3 w-3 opacity-40" />
              )}
            </button>
          </th>
        ))}
        <th className="text-left py-2 pr-2 font-medium">Flags</th>
        <th className="py-2 pr-3" />
      </tr>
    </thead>
  )

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold">Ready to Publish</h1>
          <p className="text-xs text-muted-foreground">
            Samples with every line verified, or flagged Ready for Publish /
            Ready for Partial Publish. Most critical first. An open On Hold flag
            parks a sample below.
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
          {totals.held > 0 && (
            <Badge variant="outline" className="text-muted-foreground">
              {totals.held} on hold
            </Badge>
          )}
          {(totals.scheduled ?? 0) > 0 && (
            <Badge
              variant="outline"
              className="border-sky-500/40 text-sky-400"
              data-testid="rtp-total-scheduled"
            >
              {totals.scheduled} scheduled
            </Badge>
          )}
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

      {data && live.length === 0 && (
        <div className="text-sm text-muted-foreground py-8 text-center">
          Nothing is waiting to be published.
        </div>
      )}

      {live.length > 0 && (
        <div className="rounded-md border border-border/60 overflow-x-auto">
          <table className="w-full text-sm">
            {header}
            <tbody>
              {groupByOrderOn
                ? groups.map(g => (
                    <GroupRows
                      key={g.order}
                      group={g}
                      collapsed={collapsed.has(g.order)}
                      onToggle={() => toggle(g.order)}
                      actions={actions}
                    />
                  ))
                : live.map(r => (
                    <SampleLine
                      key={r.sample_id}
                      row={r}
                      indent={false}
                      actions={actions}
                    />
                  ))}
            </tbody>
          </table>
        </div>
      )}

      {held.length > 0 && (
        <div className="rounded-md border border-border/40">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowHeld(v => !v)}
            data-testid="rtp-held-toggle"
          >
            {showHeld ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            <PauseCircle className="h-3.5 w-3.5" />
            On hold ({held.length})
            <span className="ml-auto text-[11px]">
              Release resolves the On Hold flag and the sample returns above.
            </span>
          </button>
          {showHeld && (
            <div className="overflow-x-auto border-t border-border/40">
              <table className="w-full text-sm">
                {header}
                <tbody>
                  {held.map(r => (
                    <SampleLine
                      key={r.sample_id}
                      row={r}
                      indent={false}
                      actions={actions}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {scheduled.length > 0 && (
        <div className="rounded-md border border-border/40">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowScheduled(v => !v)}
            data-testid="rtp-scheduled-toggle"
          >
            {showScheduled ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            <CalendarClock className="h-3.5 w-3.5" />
            Scheduled ({scheduled.length})
            <span className="ml-auto text-[11px]">
              Publishes automatically at the scheduled time; open the sample to
              reschedule or cancel.
            </span>
          </button>
          {showScheduled && (
            <div className="overflow-x-auto border-t border-border/40">
              <table className="w-full text-sm">
                {header}
                <tbody>
                  {scheduled.map(r => (
                    <SampleLine
                      key={r.sample_id}
                      row={r}
                      indent={false}
                      actions={actions}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function GroupRows({
  group,
  collapsed,
  onToggle,
  actions,
}: {
  group: ReturnType<typeof groupByOrder>[number]
  collapsed: boolean
  onToggle: () => void
  actions: RowActions
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
        <td className="py-2 pr-2 text-right">
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
        <td className="py-2 pr-2" />
        <td className="py-2 pr-3" />
      </tr>
      {!collapsed &&
        group.rows.map(r => (
          <SampleLine key={r.sample_id} row={r} indent actions={actions} />
        ))}
    </>
  )
}
