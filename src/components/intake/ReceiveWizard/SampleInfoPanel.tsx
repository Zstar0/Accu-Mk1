import { ChevronDown } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import type { SenaiteLookupResult } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Props {
  details: SenaiteLookupResult | null
  loading: boolean
  error: string | null
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function StackedField({
  label,
  value,
}: {
  label: string
  value: string | null | undefined
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-xs font-medium truncate" title={value || undefined}>
        {value || '—'}
      </span>
    </div>
  )
}

export function SampleInfoPanel({ details, loading, error }: Props) {
  if (loading) {
    return (
      <div className="mb-3 rounded border bg-background/40 px-2 py-2 text-xs text-muted-foreground">
        Loading sample info…
      </div>
    )
  }

  if (error) {
    return (
      <div
        className="mb-3 rounded border border-destructive/40 bg-destructive/5 px-2 py-2 text-xs text-destructive"
        title={error}
      >
        Sample info unavailable
      </div>
    )
  }

  if (!details) return null

  const declaredQty =
    details.declared_weight_mg != null
      ? `${details.declared_weight_mg} mg`
      : null
  const profiles =
    details.profiles.length > 0 ? details.profiles.join(', ') : null

  return (
    <Collapsible defaultOpen className="mb-3">
      <CollapsibleTrigger
        className={cn(
          'group flex w-full items-center justify-between rounded px-1 py-1',
          'text-xs font-semibold uppercase tracking-wide text-muted-foreground',
          'hover:text-foreground transition-colors'
        )}
      >
        <span>Sample info</span>
        <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
      </CollapsibleTrigger>

      <CollapsibleContent className="overflow-hidden">
        <div className="mt-2 flex flex-col gap-3 rounded border bg-background/40 px-2 py-2.5">
          {/* 1. Client + Contact */}
          <div className="flex flex-col gap-2">
            <StackedField label="Client" value={details.client} />
            <StackedField label="Contact" value={details.contact} />
          </div>

          {/* 2. Sample Type + Order # + Client Sample ID + Client Lot */}
          <div className="border-t border-border/50 pt-2 flex flex-col gap-2">
            <StackedField label="Sample Type" value={details.sample_type} />
            <StackedField label="Order #" value={details.client_order_number} />
            <StackedField
              label="Client Sample ID"
              value={details.client_sample_id}
            />
            <StackedField label="Client Lot" value={details.client_lot} />
          </div>

          {/* 3. Profiles + Declared Qty */}
          <div className="border-t border-border/50 pt-2 flex flex-col gap-2">
            <StackedField label="Profiles" value={profiles} />
            <StackedField label="Declared Qty" value={declaredQty} />
          </div>

          {/* 4. Date Sampled */}
          <div className="border-t border-border/50 pt-2 flex flex-col gap-2">
            <StackedField
              label="Date Sampled"
              value={
                details.date_sampled ? formatDate(details.date_sampled) : null
              }
            />
          </div>

          {/* 5. Analytes — chip per slot */}
          <div className="border-t border-border/50 pt-2 flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Analytes
            </span>
            {details.analytes.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {details.analytes.map((a, i) => {
                  const label = a.matched_peptide_name ?? a.raw_name
                  return (
                    <span
                      key={i}
                      title={
                        a.matched_peptide_name &&
                        a.matched_peptide_name !== a.raw_name
                          ? `${a.raw_name} → ${a.matched_peptide_name}`
                          : a.raw_name
                      }
                      className="inline-flex items-center rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] font-medium"
                    >
                      {label}
                    </span>
                  )
                })}
              </div>
            ) : (
              <span className="text-xs font-medium text-muted-foreground">
                —
              </span>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
