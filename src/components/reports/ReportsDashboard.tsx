import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  XCircle,
  Loader2,
  ArrowRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getReportsDashboard } from '@/lib/api'
import type { PeptideCard } from '@/lib/api'
import { PurityTrendView } from './PurityTrendView'

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

export function ReportsDashboard() {
  const [selectedPeptide, setSelectedPeptide] = useState<string | null>(null)
  const [selectedIsBlend, setSelectedIsBlend] = useState(false)

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

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-auto">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold">Reports</h1>
        <p className="text-xs text-muted-foreground">
          Overview of AccuVerify testing results
        </p>
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

          {/* Product cards (single peptides + blends) */}
          <div className="grid grid-cols-3 gap-3 xl:grid-cols-4 2xl:grid-cols-5">
            {data.peptides.map(card => (
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
        </>
      )}
    </div>
  )
}
