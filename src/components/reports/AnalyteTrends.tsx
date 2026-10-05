import { Fragment, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Loader2,
  Search,
  TrendingDown,
  TrendingUp,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getAnalyteTrends } from '@/lib/api'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  QTY_FLAG_PCT,
  RISING_PP,
  TEST_KEYS,
  TEST_LABELS,
  TREND_MIN_N,
  TREND_WINDOW_DAYS,
  buildMatrix,
  periodDays,
  type PeriodKey,
  labDate,
  rate,
  risingFailures,
  trendPP,
  type Cell,
  type ProductRow,
  type TestKey,
} from './analyte-trends-utils'
import { AnalyteTrendDetail, PeriodPicker } from './AnalyteTrendDetail'

/** Background tint by fail rate: none at 0, amber under 10%, red above. */
function failTint(failed: number, tested: number) {
  if (!tested || !failed) return ''
  return failed / tested >= 0.1
    ? 'bg-red-500/15 text-red-300'
    : 'bg-amber-500/10 text-amber-300'
}

const pctText = (x: number) => `${Math.round(x * 100)}%`

function TrendMark({ cell }: { cell: Cell }) {
  const pp = trendPP(cell)
  if (pp == null || Math.abs(pp) < 1) return null
  const up = pp > 0
  const Icon = up ? TrendingUp : TrendingDown
  return (
    <Icon
      aria-label={up ? 'fail rate rising' : 'fail rate falling'}
      className={cn(
        'h-3 w-3 shrink-0',
        up
          ? pp >= RISING_PP
            ? 'text-red-400'
            : 'text-amber-400'
          : 'text-emerald-400'
      )}
    />
  )
}

function CellCard({
  product,
  test,
  cell,
}: {
  product: string
  test: TestKey
  cell: Cell
}) {
  const pp = trendPP(cell)
  return (
    <div className="flex flex-col gap-1.5 p-3 text-xs font-mono">
      <div className="font-semibold border-b border-primary-foreground/20 pb-1.5">
        {product} · {TEST_LABELS[test]}
      </div>
      <div>
        Selected period: {cell.failed} failed / {cell.tested} tested
        {cell.tested > 0 && ` (${pctText(rate(cell))})`}
      </div>
      <div className="border-t border-primary-foreground/20 pt-1.5">
        <div>
          Last {TREND_WINDOW_DAYS}d: {cell.recent.failed}/{cell.recent.tested}
        </div>
        <div>
          Prior {TREND_WINDOW_DAYS}d: {cell.prior.failed}/{cell.prior.tested}
        </div>
        <div className="opacity-80">
          {pp == null
            ? `Trend needs ${TREND_MIN_N}+ tests in both windows`
            : `Trend ${pp >= 0 ? '+' : ''}${pp.toFixed(0)} pts`}
        </div>
      </div>
      <div className="border-t border-primary-foreground/20 pt-1.5 opacity-80">
        Click to open these results
      </div>
    </div>
  )
}

function TestCell({
  row,
  test,
  onOpen,
}: {
  row: ProductRow
  test: TestKey
  onOpen: (test: TestKey) => void
}) {
  const cell = row.cells[test]
  if (!cell.tested && !cell.recent.tested && !cell.prior.tested)
    return <span className="text-muted-foreground/30">·</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={e => {
            e.stopPropagation()
            onOpen(test)
          }}
          className={cn(
            'inline-flex items-center justify-end gap-1 rounded px-1.5 py-0.5 tabular-nums text-xs font-medium cursor-pointer hover:ring-1 hover:ring-border',
            failTint(cell.failed, cell.tested) || 'text-muted-foreground'
          )}
        >
          <TrendMark cell={cell} />
          {cell.failed}/{cell.tested}
        </button>
      </TooltipTrigger>
      <TooltipContent className="p-0 max-w-xs">
        <CellCard product={row.product} test={test} cell={cell} />
      </TooltipContent>
    </Tooltip>
  )
}

type SortKey = 'product' | 'total' | 'failed' | 'qty' | 'last' | TestKey

function sortValue(r: ProductRow, k: SortKey): number | string {
  switch (k) {
    case 'product':
      return r.product.toLowerCase()
    case 'total':
      return r.total
    case 'failed':
      return r.total ? r.failed / r.total + r.failed / 1e6 : -1
    case 'qty':
      return r.qty.median == null ? -1 : Math.abs(r.qty.median)
    case 'last':
      return r.last
    default: {
      const c = r.cells[k]
      return c.tested ? rate(c) + c.failed / 1e6 : -1
    }
  }
}

export function AnalyteTrends() {
  const [period, setPeriod] = useState<PeriodKey>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'total',
    dir: 'desc',
  })
  const [open, setOpen] = useState<{
    product: string
    test: TestKey | null
  } | null>(null)

  const { data, dataUpdatedAt, isLoading, error } = useQuery({
    queryKey: ['reports', 'analyte-trends'],
    queryFn: getAnalyteTrends,
    staleTime: 60_000,
  })

  // "now" = fetch time, so period cutoffs and trend windows agree and stay pure.
  const now = dataUpdatedAt
  const rows = useMemo(
    () => (data ? buildMatrix(data.coas, now, periodDays(period)) : []),
    [data, now, period]
  )
  const rising = useMemo(
    () => (data ? risingFailures(buildMatrix(data.coas, now, null)) : []),
    [data, now]
  )
  const visibleTests = useMemo(
    () =>
      TEST_KEYS.filter(k =>
        rows.some(r => r.cells[k].tested || r.cells[k].recent.tested)
      ),
    [rows]
  )
  const shown = useMemo(() => {
    const q = search.toLowerCase().trim()
    const list = q
      ? rows.filter(r => r.product.toLowerCase().includes(q))
      : rows
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const av = sortValue(a, sort.key)
      const bv = sortValue(b, sort.key)
      if (av < bv) return -dir
      if (av > bv) return dir
      return a.product.localeCompare(b.product)
    })
  }, [rows, search, sort])

  if (open && data) {
    return (
      <AnalyteTrendDetail
        product={open.product}
        coas={data.coas.filter(c => c.product === open.product)}
        tz={data.tz}
        now={now}
        initialTest={open.test}
        initialPeriod={period}
        onBack={() => setOpen(null)}
      />
    )
  }

  const totals = rows.reduce(
    (a, r) => ({ coas: a.coas + r.total, failed: a.failed + r.failed }),
    { coas: 0, failed: 0 }
  )

  const toggleSort = (key: SortKey) =>
    setSort(s =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'product' ? 'asc' : 'desc' }
    )

  const th = (
    key: SortKey,
    label: string,
    align: 'left' | 'right' = 'right'
  ) => (
    <th
      className={cn(
        'px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-foreground select-none whitespace-nowrap',
        align === 'right' ? 'text-right' : 'text-left'
      )}
      onClick={() => toggleSort(key)}
      aria-sort={
        sort.key === key
          ? sort.dir === 'asc'
            ? 'ascending'
            : 'descending'
          : 'none'
      }
    >
      <span
        className={cn(
          'inline-flex items-center gap-1',
          align === 'right' && 'justify-end'
        )}
      >
        {label}
        {sort.key !== key ? (
          <ArrowUpDown className="h-3 w-3 text-muted-foreground/40" />
        ) : sort.dir === 'asc' ? (
          <ArrowUp className="h-3 w-3 text-foreground" />
        ) : (
          <ArrowDown className="h-3 w-3 text-foreground" />
        )}
      </span>
    </th>
  )

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Analyte Trends</h1>
          <p className="text-xs text-muted-foreground">
            Results per product from published COAs (Additional COA copies
            excluded)
            {data && ` · lab time (${data.tz})`}
          </p>
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 text-red-400 py-8 justify-center text-sm">
          <XCircle className="h-4 w-4" />
          Failed to load analyte trends
        </div>
      )}

      {data && (
        <>
          <div className="flex flex-wrap items-stretch gap-3">
            <Stat value={rows.length} label="Products" />
            <Stat value={totals.coas} label="COAs" />
            <Stat
              value={totals.failed}
              label={`Non-conforming${totals.coas ? ` · ${pctText(totals.failed / totals.coas)}` : ''}`}
              tone={totals.failed ? 'red' : undefined}
            />
            <RisingPanel
              items={rising}
              onOpen={(product, test) => setOpen({ product, test })}
            />
          </div>

          <div className="relative w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search products..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-8 h-8 text-sm"
            />
          </div>

          <div className="rounded-lg border border-border/60 overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-muted/30 border-b border-border/40">
                  {th('product', 'Product', 'left')}
                  {th('total', 'COAs')}
                  {th('failed', 'Non-conf')}
                  {visibleTests.map(k => (
                    <Fragment key={k}>{th(k, TEST_LABELS[k])}</Fragment>
                  ))}
                  {th('qty', 'Qty Δ')}
                  {th('last', 'Last COA')}
                </tr>
              </thead>
              <tbody>
                {shown.map(r => (
                  <tr
                    key={r.product}
                    className="border-b border-border/20 hover:bg-muted/30 transition-colors cursor-pointer"
                    onClick={() => setOpen({ product: r.product, test: null })}
                  >
                    <td className="px-3 py-2 max-w-[28rem]">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground truncate">
                          {r.product}
                        </span>
                        {r.is_blend && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 font-medium">
                            Blend
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-sm tabular-nums">
                      {r.total}
                    </td>
                    <td className="px-3 py-2 text-right text-sm tabular-nums">
                      {r.failed ? (
                        <span className="text-red-400">
                          {r.failed}
                          <span className="text-muted-foreground text-xs ml-1">
                            {pctText(r.failed / r.total)}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">0</span>
                      )}
                    </td>
                    {visibleTests.map(k => (
                      <td key={k} className="px-3 py-2 text-right">
                        <TestCell
                          row={r}
                          test={k}
                          onOpen={test => setOpen({ product: r.product, test })}
                        />
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right text-xs tabular-nums">
                      <QtyCell row={r} />
                    </td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                      {r.last ? labDate(r.last, data.tz) : ''}
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td
                      colSpan={5 + visibleTests.length}
                      className="px-3 py-8 text-center text-sm text-muted-foreground"
                    >
                      {search
                        ? 'No products match the search'
                        : 'No COAs published in this period'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Cells show failed / tested. Arrows compare the fail rate of the last{' '}
            {TREND_WINDOW_DAYS} days with the {TREND_WINDOW_DAYS} before (shown
            once each window has {TREND_MIN_N}+ tests). Qty Δ is the median of
            measured vs declared mass.
          </p>
        </>
      )}
    </div>
  )
}

function Stat({
  value,
  label,
  tone,
}: {
  value: number
  label: string
  tone?: 'red'
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/50 px-4 py-3 min-w-[8rem]">
      <div
        className={cn(
          'text-2xl font-bold tabular-nums',
          tone === 'red' ? 'text-red-400' : 'text-foreground'
        )}
      >
        {value}
      </div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
    </div>
  )
}

function QtyCell({ row }: { row: ProductRow }) {
  const { n, median, flagged } = row.qty
  if (median == null) return <span className="text-muted-foreground/30">·</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'rounded px-1.5 py-0.5',
            Math.abs(median) > QTY_FLAG_PCT
              ? 'bg-red-500/15 text-red-300'
              : flagged
                ? 'text-amber-300'
                : 'text-muted-foreground'
          )}
        >
          {median >= 0 ? '+' : ''}
          {median.toFixed(1)}%
        </span>
      </TooltipTrigger>
      <TooltipContent className="p-0 max-w-xs">
        <div className="flex flex-col gap-1.5 p-3 text-xs font-mono">
          <div className="font-semibold border-b border-primary-foreground/20 pb-1.5">
            {row.product} · Quantity
          </div>
          <div>Median measured vs declared: {median.toFixed(1)}%</div>
          <div>COAs with both values: {n}</div>
          <div>
            Off by more than {QTY_FLAG_PCT}%: {flagged}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function RisingPanel({
  items,
  onOpen,
}: {
  items: ReturnType<typeof risingFailures>
  onOpen: (product: string, test: TestKey) => void
}) {
  return (
    <div className="flex-1 min-w-[18rem] rounded-lg border border-border/50 bg-card/50 px-4 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1.5">
        Rising failures · last {TREND_WINDOW_DAYS}d vs prior {TREND_WINDOW_DAYS}
        d
      </div>
      {items.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          No product has a fail rate up {RISING_PP}+ points with {TREND_MIN_N}+
          tests in both windows.
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.slice(0, 8).map(i => (
            <button
              key={`${i.product}|${i.test}`}
              type="button"
              onClick={() => onOpen(i.product, i.test)}
              className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-xs text-red-300 hover:bg-red-500/20 cursor-pointer"
            >
              <TrendingUp className="h-3 w-3" />
              <span className="font-medium text-foreground">{i.product}</span>
              {TEST_LABELS[i.test]} {pctText(rate(i.prior))} →{' '}
              {pctText(rate(i.recent))}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
