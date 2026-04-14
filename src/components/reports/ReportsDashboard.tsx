import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  XCircle,
  Loader2,
  ArrowRight,
  LayoutGrid,
  Table2,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Search,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getReportsDashboard } from '@/lib/api'
import type { PeptideCard } from '@/lib/api'
import { PurityTrendView } from './PurityTrendView'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

function StatCard({
  value,
  label,
  accent,
}: {
  value: number
  label: string
  accent?: 'emerald' | 'red' | 'blue' | 'amber'
}) {
  const colors = {
    emerald: 'text-emerald-400 border-emerald-500/30',
    red: 'text-red-400 border-red-500/30',
    blue: 'text-blue-400 border-blue-500/30',
    amber: 'text-amber-400 border-amber-500/30',
  }
  const c = accent ? colors[accent] : 'text-foreground border-border/50'
  return (
    <div className={cn('rounded-lg border bg-card/50 px-4 py-3', c)}>
      <div className={cn('text-2xl font-bold tabular-nums', accent ? c.split(' ')[0] : 'text-foreground')}>
        {value}
      </div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
    </div>
  )
}

function PeptideCardItem({
  card,
  onClick,
}: {
  card: PeptideCard
  onClick: () => void
}) {
  const allConform = card.non_conforming === 0 && card.conforming > 0
  const borderColor = allConform ? 'border-emerald-500/40' : card.non_conforming > 0 ? 'border-red-500/30' : 'border-border/50'

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left rounded-lg border bg-card/50 p-3 transition-colors hover:bg-muted/50 cursor-pointer group',
        borderColor
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold text-foreground leading-tight">{card.analyte_name}</h3>
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/50 group-hover:text-foreground shrink-0 mt-0.5 transition-colors" />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] mb-2">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Total COAs</span>
          <span className="font-medium tabular-nums">{card.total_coas}</span>
        </div>
        {card.additional_coas > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Additional</span>
            <span className="font-medium tabular-nums">{card.additional_coas}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-muted-foreground">Conform</span>
          <span className="font-medium tabular-nums text-emerald-400">{card.conforming}</span>
        </div>
        {card.non_conforming > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Non-conform</span>
            <span className="font-medium tabular-nums text-red-400">{card.non_conforming}</span>
          </div>
        )}
      </div>

      {card.most_recent_code && (
        <div className="border-t border-border/30 pt-1.5 mt-1.5">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
            Most Recent
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Code</span>
              <span className="font-mono text-blue-400">{card.most_recent_code}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Sample</span>
              <span className="font-medium truncate ml-2">{card.most_recent_sample || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <span className={cn(
                'font-medium',
                card.most_recent_status === 'PASSED' ? 'text-emerald-400' : 'text-red-400'
              )}>
                {card.most_recent_status === 'PASSED' ? 'Conforms' : 'Non-conforming'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Date</span>
              <span className="tabular-nums">{card.most_recent_date || '—'}</span>
            </div>
            {card.most_recent_lot && (
              <div className="flex justify-between col-span-2">
                <span className="text-muted-foreground">Lot</span>
                <span className="font-medium">{card.most_recent_lot}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </button>
  )
}

// ─── Table View ──────────────────────────────────────────────────────────────

type SortField = 'analyte_name' | 'total_coas' | 'conforming' | 'non_conforming' | 'additional_coas'
type SortDir = 'asc' | 'desc'

function SortIcon({ field, sortField, sortDir }: { field: SortField; sortField: SortField; sortDir: SortDir }) {
  if (field !== sortField) return <ArrowUpDown className="h-3 w-3 text-muted-foreground/40" />
  return sortDir === 'asc'
    ? <ArrowUp className="h-3 w-3 text-foreground" />
    : <ArrowDown className="h-3 w-3 text-foreground" />
}

function PeptideTable({
  cards,
  onSelect,
}: {
  cards: PeptideCard[]
  onSelect: (name: string, isBlend: boolean) => void
}) {
  const [search, setSearch] = useState('')
  const [sortField, setSortField] = useState<SortField>('analyte_name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir(field === 'analyte_name' ? 'asc' : 'desc')
    }
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    let rows = cards
    if (q) {
      rows = rows.filter(c => c.analyte_name.toLowerCase().includes(q))
    }
    return [...rows].sort((a, b) => {
      const av = a[sortField]
      const bv = b[sortField]
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      const an = av as number
      const bn = bv as number
      return sortDir === 'asc' ? an - bn : bn - an
    })
  }, [cards, search, sortField, sortDir])

  const thClass = 'px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-foreground transition-colors select-none'

  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-64">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder="Search products..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-8 h-8 text-sm"
        />
      </div>

      <div className="rounded-lg border border-border/60 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-muted/30 border-b border-border/40">
              <th className={cn(thClass, 'text-left w-[40%]')} onClick={() => toggleSort('analyte_name')}>
                <span className="inline-flex items-center gap-1.5">
                  Product
                  <SortIcon field="analyte_name" sortField={sortField} sortDir={sortDir} />
                </span>
              </th>
              <th className={cn(thClass, 'text-right')} onClick={() => toggleSort('total_coas')}>
                <span className="inline-flex items-center gap-1.5 justify-end">
                  Total COAs
                  <SortIcon field="total_coas" sortField={sortField} sortDir={sortDir} />
                </span>
              </th>
              <th className={cn(thClass, 'text-right')} onClick={() => toggleSort('conforming')}>
                <span className="inline-flex items-center gap-1.5 justify-end">
                  Conforming
                  <SortIcon field="conforming" sortField={sortField} sortDir={sortDir} />
                </span>
              </th>
              <th className={cn(thClass, 'text-right')} onClick={() => toggleSort('non_conforming')}>
                <span className="inline-flex items-center gap-1.5 justify-end">
                  Non-Conform
                  <SortIcon field="non_conforming" sortField={sortField} sortDir={sortDir} />
                </span>
              </th>
              <th className={cn(thClass, 'text-right')} onClick={() => toggleSort('additional_coas')}>
                <span className="inline-flex items-center gap-1.5 justify-end">
                  Additional
                  <SortIcon field="additional_coas" sortField={sortField} sortDir={sortDir} />
                </span>
              </th>
              <th className={cn(thClass, 'text-center')}>Rate</th>
              <th className={cn(thClass, 'text-center w-16')} />
            </tr>
          </thead>
          <tbody>
            {filtered.map(card => {
              const total = card.conforming + card.non_conforming
              const rate = total > 0 ? Math.round((card.conforming / total) * 100) : null
              const allConform = card.non_conforming === 0 && card.conforming > 0

              return (
                <tr
                  key={card.analyte_name}
                  className="border-b border-border/20 hover:bg-muted/30 transition-colors cursor-pointer group"
                  onClick={() => onSelect(card.analyte_name, card.is_blend)}
                >
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{card.analyte_name}</span>
                      {card.is_blend && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 font-medium">
                          Blend
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right text-sm font-medium tabular-nums">
                    {card.total_coas}
                  </td>
                  <td className="px-3 py-2.5 text-right text-sm font-medium tabular-nums text-emerald-400">
                    {card.conforming}
                  </td>
                  <td className="px-3 py-2.5 text-right text-sm font-medium tabular-nums">
                    {card.non_conforming > 0 ? (
                      <span className="text-red-400">{card.non_conforming}</span>
                    ) : (
                      <span className="text-muted-foreground/40">0</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right text-sm font-medium tabular-nums">
                    {card.additional_coas > 0 ? card.additional_coas : (
                      <span className="text-muted-foreground/40">0</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {rate != null ? (
                      <span className={cn(
                        'text-xs font-semibold tabular-nums px-2 py-0.5 rounded-full',
                        allConform
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : rate >= 90
                            ? 'bg-amber-500/15 text-amber-400'
                            : 'bg-red-500/15 text-red-400'
                      )}>
                        {rate}%
                      </span>
                    ) : (
                      <span className="text-muted-foreground/40 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-foreground transition-colors inline-block" />
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {search ? 'No products matching search' : 'No data'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Main Dashboard ──────────────────────────────────────────────────────────

type ViewMode = 'cards' | 'table'

export function ReportsDashboard() {
  const [selectedPeptide, setSelectedPeptide] = useState<string | null>(null)
  const [selectedIsBlend, setSelectedIsBlend] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('table')

  const { data, isLoading, error } = useQuery({
    queryKey: ['reports', 'dashboard'],
    queryFn: getReportsDashboard,
    staleTime: 60_000,
  })

  if (selectedPeptide) {
    return (
      <PurityTrendView
        analyteName={selectedPeptide}
        isBlend={selectedIsBlend}
        onBack={() => setSelectedPeptide(null)}
      />
    )
  }

  const allCards = data ? [...data.peptides] : []

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Reports</h1>
          <p className="text-xs text-muted-foreground">
            Overview of AccuVerify testing results
          </p>
        </div>
        <div className="flex items-center gap-0.5 rounded-lg border border-border/60 p-0.5">
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-7 w-7 cursor-pointer', viewMode === 'cards' && 'bg-accent')}
            onClick={() => setViewMode('cards')}
            title="Card view"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-7 w-7 cursor-pointer', viewMode === 'table' && 'bg-accent')}
            onClick={() => setViewMode('table')}
            title="Table view"
          >
            <Table2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-red-400 py-8 justify-center text-sm">
          <XCircle className="h-4 w-4" />
          Failed to load reports
        </div>
      )}

      {data && (
        <>
          {/* Summary row */}
          <div className="grid grid-cols-4 gap-3">
            <StatCard value={data.summary.total_peptides} label="Products" accent="blue" />
            <StatCard value={data.summary.total_coas} label="Total COAs" accent="amber" />
            <StatCard value={data.summary.conforming} label="Conforming" accent="emerald" />
            <StatCard value={data.summary.non_conforming} label="Non-Conforming" accent="red" />
          </div>

          {viewMode === 'cards' ? (
            <div className="grid grid-cols-3 gap-3 xl:grid-cols-4 2xl:grid-cols-5">
              {allCards.map(card => (
                <PeptideCardItem
                  key={card.analyte_name}
                  card={card}
                  onClick={() => {
                    setSelectedPeptide(card.analyte_name)
                    setSelectedIsBlend(card.is_blend)
                  }}
                />
              ))}
            </div>
          ) : (
            <PeptideTable
              cards={allCards}
              onSelect={(name, isBlend) => {
                setSelectedPeptide(name)
                setSelectedIsBlend(isBlend)
              }}
            />
          )}
        </>
      )}
    </div>
  )
}
