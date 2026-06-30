import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Package } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { ReceiveWizard } from '@/components/intake/ReceiveWizard/ReceiveWizard'
import { BoxStep } from '@/components/intake/ReceiveWizard/BoxStep'
import { useParentSampleDetails } from '@/components/intake/ReceiveWizard/useParentSampleDetails'
import { listSubSamples, type SenaiteSample } from '@/lib/api'
import type { SenaiteLookupResult } from '@/lib/api'
import type { OrderGroup } from '@/lib/inbox-orders'
import { cn } from '@/lib/utils'

interface Props {
  order: OrderGroup
  onClose: () => void
}

/** Comma-joined analyte labels for the header, preferring the enriched SENAITE
 *  lookup (matched peptide names) and falling back to the raw list carried on
 *  the inbox SenaiteSample. */
function analyteLabel(
  details: SenaiteLookupResult | null,
  sample: SenaiteSample
): string | null {
  const fromDetails = details?.analytes
    ?.map(a => a.matched_peptide_name || a.raw_name)
    .filter(Boolean)
  if (fromDetails && fromDetails.length) return fromDetails.join(', ')
  if (sample.analytes?.length) return sample.analytes.join(', ')
  return null
}

export function OrderReceiveSession({ order, onClose }: Props) {
  // index 0..n-1 = walking samples; index === n = order-level boxing stage
  const [index, setIndex] = useState(0)
  const total = order.samples.length
  const onBoxing = index >= total
  const current = order.samples[Math.min(index, total - 1)]

  // Enrich the active sample's header context (client, type, analytes, lot).
  // Hook runs unconditionally (stable order) even on the empty-order guard path.
  const details = useParentSampleDetails(current?.id ?? '')

  if (!current) return null

  const d = details.details
  const clientName = d?.client ?? order.clientId ?? current.client_id
  const contact = d?.contact ?? null
  const sampleType = d?.sample_type ?? current.sample_type
  const orderNumber = d?.client_order_number ?? current.client_order_number ?? null
  const clientSampleId = d?.client_sample_id ?? null
  const lot = d?.client_lot ?? null
  const declaredQty = d?.declared_weight_mg != null ? `${d.declared_weight_mg} mg` : null
  const analytes = analyteLabel(d, current)

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent
        className="max-w-[95vw] w-[95vw] sm:max-w-[95vw] h-[92vh] p-0 gap-0 grid-rows-[auto_1fr] overflow-hidden"
      >
        {/* Radix requires a labelled title; the styled header below is the
            visible heading, so the DialogTitle is visually hidden. */}
        <DialogTitle className="sr-only">Receive {order.orderLabel}</DialogTitle>

        {/* ── Header bar ───────────────────────────────────────────────── */}
        <header className="flex flex-col gap-2.5 px-6 py-3 border-b bg-muted/10">
          {/* Top row: order label + active sample id, progress indicator */}
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <h2 className="text-base font-semibold leading-tight truncate">
                Receive {order.orderLabel}
                {clientName && (
                  <span className="text-muted-foreground font-normal">
                    {' · '}{clientName}
                  </span>
                )}
              </h2>
              {onBoxing ? (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Package className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Assign this order’s vials into boxes</span>
                </div>
              ) : (
                <span className="font-mono text-sm text-foreground truncate">
                  {current.id}
                </span>
              )}
            </div>
            <div className="flex flex-col items-end gap-0.5 shrink-0">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {onBoxing ? 'Stage' : 'Progress'}
              </span>
              <span className="text-sm font-mono font-semibold tabular-nums">
                {onBoxing ? 'Boxing' : `Sample ${index + 1} of ${total}`}
              </span>
            </div>
          </div>

          {/* Per-sample info strip — wraps gracefully, '—' fallbacks. Omitted
              on the boxing stage, where the info is order-level (shown above). */}
          {!onBoxing && (
            <div className="flex flex-wrap items-start gap-x-6 gap-y-2 border-t pt-2.5">
              <HeaderField label="Contact" value={contact} />
              <HeaderField label="Sample Type" value={sampleType} />
              <HeaderField label="Order #" value={orderNumber} />
              <HeaderField label="Client Sample ID" value={clientSampleId} />
              <HeaderField label="Client Lot" value={lot} />
              <HeaderField label="Declared Qty" value={declaredQty} />
              <HeaderField label="Analytes" value={analytes} className="max-w-[28rem]" />
            </div>
          )}
        </header>

        {/* ── Rail + main ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-[220px_1fr] min-h-0 overflow-hidden">
          {/* Left rail: sample list + boxing entry */}
          <nav className="flex flex-col min-h-0 border-r bg-muted/5">
            <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b">
              Samples
            </div>
            <ul className="flex-1 min-h-0 overflow-y-auto py-1">
              {order.samples.map((s, i) => (
                <li key={s.uid}>
                  <SampleRailRow
                    sample={s}
                    active={!onBoxing && i === index}
                    onSelect={() => setIndex(i)}
                  />
                </li>
              ))}
            </ul>
            <div className="border-t p-1">
              <button
                type="button"
                onClick={() => setIndex(total)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  'border-l-2',
                  onBoxing
                    ? 'border-primary bg-primary/10 text-foreground font-medium'
                    : 'border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                )}
              >
                <Package className="h-4 w-4 shrink-0" aria-hidden="true" />
                Boxing
              </button>
            </div>
          </nav>

          {/* Main area */}
          <div className="min-h-0 overflow-hidden">
            {onBoxing ? (
              <BoxStep
                orderKey={order.orderKey ?? current.id}
                orderLabel={order.orderLabel}
                clientId={order.clientId}
                sampleIds={order.samples.map(s => s.id)}
              />
            ) : (
              <ReceiveWizard
                key={current.uid}
                parent={{ uid: current.uid, sample_id: current.id, status: current.review_state ?? null }}
                onClose={onClose}
                hideSampleInfo
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** One compact key/value cell in the header info strip. Stacked label/value
 *  with a truncating value (full text on hover) so the strip stays a tidy
 *  single-line-per-field row that wraps as the dialog narrows. */
function HeaderField({
  label,
  value,
  className,
}: {
  label: string
  value: string | null | undefined
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-0.5 min-w-0', className)}>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-xs font-medium truncate" title={value || undefined}>
        {value || '—'}
      </span>
    </div>
  )
}

/** A single sample row in the left rail. Lazily fetches the sub-sample count
 *  so a ✓ marks samples that already have received vials. staleTime keeps the
 *  per-sample lookups from refiring as the tech walks the order. */
function SampleRailRow({
  sample,
  active,
  onSelect,
}: {
  sample: SenaiteSample
  active: boolean
  onSelect: () => void
}) {
  const subQ = useQuery({
    queryKey: ['order-rail-sub-count', sample.id],
    queryFn: () => listSubSamples(sample.id),
    staleTime: 5 * 60_000,
  })
  const received = (subQ.data?.parent.sub_sample_count ?? 0) > 0

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors border-l-2',
        active
          ? 'border-primary bg-primary/10 text-foreground font-medium'
          : 'border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
      )}
    >
      <span
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center',
          received ? 'text-emerald-500' : 'text-transparent'
        )}
        aria-hidden="true"
      >
        <Check className="h-3.5 w-3.5" />
      </span>
      <span className="font-mono truncate">{sample.id}</span>
    </button>
  )
}
