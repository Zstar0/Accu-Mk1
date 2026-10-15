import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  getWorksheet,
  listConsumables,
  type WorksheetListItem,
  type WorksheetUser,
} from '@/lib/api'
import { fmt, labDate } from '@/lib/endo-prep'
import { mk1Value, prep2Result, type EndoVerdict } from '@/lib/endo-prep-2ml'
import {
  bacWaterLast,
  endoCtxFor,
  endoRowsFor,
  runCartridgeFor,
} from '@/lib/endo-worksheet-2ml'
import { worksheetPageKey } from '@/hooks/use-worksheet-drawer'
import {
  endoIdentityFor,
  endoItemsInBenchOrder,
  isEndoWorksheetItem,
  shortLabDate,
} from '@/lib/endo-worksheet'
import { worksheetItemSlaSubjects } from '@/lib/worksheet-sla-subjects'
import { displayName } from '@/lib/user-display'
import { useLabCalendar } from '@/hooks/use-lab-calendar'
import { useSlaForSubjects } from '@/services/sla-subjects'
import { useUIStore } from '@/store/ui-store'
import { EndoWorksheetActions } from '@/components/hplc/EndoWorksheetActions'
import {
  MONO,
  Meta,
  SampleLink,
  STATUS_CHIP,
} from '@/components/hplc/EndoWorksheetTable'
import { VERDICT_LABEL, VERDICT_TONE } from './EndoResultsBox'

function Count({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
      <dt>{label}</dt>
      <dd className="font-mono text-[13px] font-medium tabular-nums text-foreground">
        {children}
      </dd>
    </div>
  )
}

function TickMark({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      role="img"
      aria-label={`${label}: ${on ? 'yes' : 'no'}`}
      className={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border ${on ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-600 dark:border-emerald-400/50 dark:bg-emerald-400/15 dark:text-emerald-400' : 'border-border text-transparent'}`}
    >
      <Check className="h-3 w-3" strokeWidth={3} />
    </span>
  )
}

/**
 * The endotoxin flyout, read-only (spec 6.2): the run at a glance and a way
 * to its page, where it is worked. Every caller that opens the flyout (flags,
 * the worksheets list, sample details, the main window) still lands here.
 * The list payload carries no endo_method, so the run settings come from GET
 * /worksheets/{id}, read under the page's own key; the results counts wait
 * for it rather than show numbers worked out on the wrong method.
 */
export function EndoFlyoutSummary({
  worksheet,
  users,
}: {
  worksheet: WorksheetListItem
  users: WorksheetUser[]
}) {
  const {
    data: full,
    isError,
    refetch,
  } = useQuery({
    queryKey: worksheetPageKey(worksheet.id),
    queryFn: () => getWorksheet(worksheet.id),
    staleTime: 30_000,
  })
  const ws = full ?? worksheet
  // The allowed list when no method resolves, or the method links no
  // cartridges (4.3), as the page reads it.
  const { data: catalog = [] } = useQuery({
    queryKey: ['consumables', 'endo_cartridge'],
    queryFn: () => listConsumables({ kind: 'endo_cartridge' }),
    staleTime: 5 * 60_000,
  })
  const { calendar } = useLabCalendar()
  const items = ws.items.filter(isEndoWorksheetItem)
  const { byKey } = useSlaForSubjects(
    worksheetItemSlaSubjects(
      items,
      ws.status === 'completed' ? ws.completed_at : null
    )
  )
  const dueAt = new Map(
    items.map(it => [it.id, byKey.get(String(it.id))?.status.due_at ?? null])
  )
  const twoMl = ws.endo_prep === '2ml'
  // Numbered as Box 1 numbers them: on 2 mL, bac water last.
  const bench = endoItemsInBenchOrder(items, dueAt, calendar)
  const rows = twoMl ? bacWaterLast(bench) : bench
  const ready = full !== undefined
  // Not worked out (yet): loading, or the read failed and is offered again.
  const unknown = isError ? '-' : '…'

  const judged = new Map<number, { verdict: EndoVerdict; toMk1: boolean }>()
  if (twoMl && ready) {
    const ctx = endoCtxFor(ws, catalog)
    for (const row of endoRowsFor(rows, ws, catalog)) {
      judged.set(row.item.id, {
        verdict: prep2Result(row.sample, ctx).verdict,
        toMk1: mk1Value(row.sample, ctx) !== null,
      })
    }
  }
  const n = rows.length
  const made = rows.filter(it => it.made_at).length
  const ran = rows.filter(it => it.ran_at).length
  const resultsIn = rows.filter(it => it.result_reading).length
  const verdicts = [...judged.values()]
  const invalid = verdicts.filter(v => v.verdict === 'invalid').length
  const toMk1 = verdicts.filter(v => v.toMk1).length
  const runDue =
    rows
      .map(it => (calendar ? labDate(dueAt.get(it.id), calendar) : null))
      .filter((d): d is string => !!d)
      .sort()[0] ?? null
  const analyst = users.find(u => u.id === ws.assigned_analyst)
  const lambda = runCartridgeFor(ws, catalog)?.sensitivity ?? null

  return (
    <div className="min-w-0 flex-1 space-y-4 overflow-y-auto px-6 pb-8 pt-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-[23px] font-semibold leading-tight tracking-tight">
            {ws.title}
          </h2>
          <span className="font-mono text-xs tracking-wide text-muted-foreground">
            WS-{ws.id} · {ws.status} · summary; the run is worked on its page
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <EndoWorksheetActions worksheet={ws} users={users} />
          <Button
            size="sm"
            className="bg-teal-600 text-white hover:bg-teal-600/90"
            onClick={() => {
              const ui = useUIStore.getState()
              ui.closeWorksheetDrawer()
              ui.navigateToWorksheet(ws.id)
            }}
          >
            Open worksheet
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] overflow-hidden rounded-[5px] border bg-card shadow-sm">
        <Meta label="Analyst">
          <span className="block truncate text-sm font-medium">
            {analyst
              ? displayName(analyst)
              : (ws.assigned_analyst_email ?? '-')}
          </span>
        </Meta>
        <Meta label="Due" title="The earliest due date on this run">
          <span className={MONO}>{shortLabDate(runDue)}</span>
        </Meta>
        <Meta label="Prep">
          <span className="block truncate text-sm font-medium">
            {twoMl ? '2 mL' : '1 mg/mL stock'}
          </span>
        </Meta>
        {twoMl && (
          <Meta label="Run cartridge">
            <span className={MONO}>
              {lambda === null ? '-' : `${fmt(lambda)} EU/mL`}
            </span>
          </Meta>
        )}
      </div>

      <dl
        aria-label="Run counts"
        className="flex flex-wrap gap-x-6 gap-y-2 rounded-[5px] border bg-muted/60 px-3.5 py-2.5"
      >
        <Count label="Rows">{n}</Count>
        <Count label="Made">{`${made}/${n}`}</Count>
        <Count label="MCS">{`${ran}/${n}`}</Count>
        {twoMl && (
          <>
            <Count label="Results in">{`${resultsIn}/${n}`}</Count>
            <Count label="Invalid">{ready ? invalid : unknown}</Count>
            <Count label="Ready for Mk1">
              {ready ? `${toMk1}/${n}` : unknown}
            </Count>
          </>
        )}
      </dl>
      {twoMl && isError && !ready && (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-2 text-xs font-medium text-red-600 dark:text-red-400"
        >
          Could not load the run settings, so Invalid and Ready for Mk1 are not
          worked out.
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            Retry
          </Button>
        </p>
      )}

      <ol className="overflow-hidden rounded-[5px] border bg-card shadow-sm">
        {rows.map((it, i) => {
          const [statusLabel, statusClass] = STATUS_CHIP[it.prep_status] ??
            STATUS_CHIP.ready ?? ['', '']
          const v = judged.get(it.id)?.verdict ?? null
          const identity = endoIdentityFor(it)
          return (
            <li
              key={it.id}
              className="flex items-center gap-3 border-b px-3.5 py-1.5 text-[13px] last:border-b-0"
            >
              <span className="w-6 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                {i + 1}
              </span>
              <span className="w-[120px] shrink-0 font-mono text-[12.5px]">
                <SampleLink id={it.sample_id} />
              </span>
              <span
                className="min-w-0 flex-1 truncate text-muted-foreground"
                title={identity}
              >
                {identity || '-'}
              </span>
              <span
                className={`inline-block whitespace-nowrap rounded-[3px] border px-1.5 py-0.5 text-[11px] font-medium ${statusClass}`}
              >
                {statusLabel}
              </span>
              <TickMark on={!!it.made_at} label="Made" />
              <TickMark on={!!it.ran_at} label="MCS" />
              {twoMl && (
                <span
                  className={`w-[84px] shrink-0 text-right text-xs font-semibold ${v ? VERDICT_TONE[v] : 'text-muted-foreground'}`}
                >
                  {v ? VERDICT_LABEL[v] : '-'}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export default EndoFlyoutSummary
