import { useEffect, useRef, useState } from 'react'
import { Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { LabelTemplate } from './LabelTemplate'
import { getVialPlan, getOrderBoxLabelSummary, type VialPlanItem, type OrderBoxLabelSummary } from '@/lib/api'
import { OrderLabelTemplate } from './OrderLabelTemplate'
import { vialPosition } from '@/lib/vial-label'
import './PrintStep.css'

interface PrintLabel {
  sample_id: string
  /** ISO string of when this vial was checked in. Optional — label falls
   *  back to today's date if omitted. */
  received_at?: string | null
}

interface Props {
  parentSampleId: string
  vials: PrintLabel[]
  orderNumber?: string | null
}

/**
 * Print Labels tab body. Auto-print on mount was removed when this became
 * a peer tab — printing is now an explicit click. Per-label checkboxes let
 * a tech skip any subset (a label that printed badly, a vial already labeled
 * from a previous session, etc.). Default is all checked since the dominant
 * case is "print everything I just captured".
 */
export function PrintStep({ parentSampleId, vials, orderNumber }: Props) {
  const [planByVial, setPlanByVial] = useState<Record<string, VialPlanItem>>({})
  const [vialTotal, setVialTotal] = useState<number | null>(null)
  // Container family: position = vial_sequence (S01 IS Vial 1); legacy +1.
  const [containerMode, setContainerMode] = useState(false)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () => new Set(vials.map(v => v.sample_id)),
  )
  const [orderSummary, setOrderSummary] = useState<OrderBoxLabelSummary | null>(null)
  const [printMode, setPrintMode] = useState<'vials' | 'order'>('vials')

  // Pull vial-plan to enrich each label with assignment_role + vial position.
  // Soft fail: if plan isn't available, labels print without role/position.
  useEffect(() => {
    let cancelled = false
    void getVialPlan(parentSampleId)
      .then(plan => {
        if (cancelled) return
        const lookup: Record<string, VialPlanItem> = {}
        plan.vials.forEach(v => {
          lookup[v.sample_id] = v
        })
        setPlanByVial(lookup)
        setVialTotal(plan.vials.length)
        setContainerMode(plan.container_mode ?? false)
      })
      .catch(() => {
        // intentional: print proceeds without role enrichment
      })
    return () => {
      cancelled = true
    }
  }, [parentSampleId])

  // When vials list changes (new vial saved in Vial Management), preserve
  // existing check state and default new vials to checked.
  useEffect(() => {
    setCheckedIds(prev => {
      const next = new Set(prev)
      const currentIds = new Set(vials.map(v => v.sample_id))
      // Drop ids no longer in the list (e.g., vial deleted).
      for (const id of next) {
        if (!currentIds.has(id)) next.delete(id)
      }
      // Add any new vials (default checked).
      for (const id of currentIds) {
        if (!prev.has(id)) next.add(id)
      }
      return next
    })
  }, [vials])

  const toggle = (id: string) => {
    setCheckedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allChecked = vials.length > 0 && vials.every(v => checkedIds.has(v.sample_id))
  const noneChecked = vials.every(v => !checkedIds.has(v.sample_id))
  const selectedCount = vials.filter(v => checkedIds.has(v.sample_id)).length

  const selectAll = () => setCheckedIds(new Set(vials.map(v => v.sample_id)))
  const clearAll = () => setCheckedIds(new Set())

  // Guard against a double-click during the fetch window firing two print
  // chains (physical labels are expensive — a stray second print dialog can
  // waste a label). Reset once the print fires or the fetch fails.
  const orderPrintInFlight = useRef(false)
  const printOrderLabels = async () => {
    if (!orderNumber || orderPrintInFlight.current) return
    orderPrintInFlight.current = true
    try {
      const summary = await getOrderBoxLabelSummary(orderNumber)
      setOrderSummary(summary)
      setPrintMode('order')
      // wait two frames so the order-label DOM mounts before printing
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          window.print()
          setPrintMode('vials')
          orderPrintInFlight.current = false
        }),
      )
    } catch {
      // soft-fail: a failed summary fetch just doesn't print (matches getVialPlan's soft-fail)
      orderPrintInFlight.current = false
    }
  }

  return (
    <div className="grid grid-rows-[auto_1fr] h-full min-h-0">
      <div className="screen-only px-6 py-3 border-b flex items-center gap-3 bg-muted/10 print-controls">
        <span className="text-sm font-medium">
          {selectedCount} of {vials.length} label{vials.length === 1 ? '' : 's'} selected
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={selectAll}
          disabled={allChecked || vials.length === 0}
        >
          Select all
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={clearAll}
          disabled={noneChecked}
        >
          Clear all
        </Button>
        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void printOrderLabels()}
            disabled={!orderNumber}
            className="gap-2"
          >
            <Printer className="w-4 h-4" aria-hidden="true" />
            Print Order #
          </Button>
          <Button
            type="button"
            onClick={() => window.print()}
            disabled={selectedCount === 0}
            className="gap-2"
          >
            <Printer className="w-4 h-4" aria-hidden="true" />
            Print {selectedCount > 0 ? `${selectedCount} ` : ''}label{selectedCount === 1 ? '' : 's'}
          </Button>
        </div>
      </div>

      <div className="overflow-y-auto p-6">
        {vials.length === 0 ? (
          <p className="text-muted-foreground screen-only">
            No vials in this session — nothing to print.
          </p>
        ) : (
          <div className={printMode === 'order' ? 'screen-only' : 'print-area'}>
            {vials.map(v => {
              const planItem = planByVial[v.sample_id]
              const role = planItem?.assignment_role ?? null
              const position = planItem
                ? vialPosition(planItem.vial_sequence, containerMode)
                : null
              const isChecked = checkedIds.has(v.sample_id)
              return (
                <div
                  key={v.sample_id}
                  className={`label-row ${isChecked ? '' : 'label-row-unchecked'}`}
                >
                  <Checkbox
                    checked={isChecked}
                    onCheckedChange={() => toggle(v.sample_id)}
                    className="label-checkbox screen-only"
                    aria-label={`Include ${v.sample_id} when printing`}
                  />
                  <LabelTemplate
                    sampleId={v.sample_id}
                    orderNumber={orderNumber}
                    vialPosition={position}
                    vialTotal={vialTotal}
                    role={role}
                    receivedAt={v.received_at ?? null}
                  />
                </div>
              )
            })}
          </div>
        )}
        {orderSummary && (
          <div className={printMode === 'order' ? 'print-area order-print-area' : 'order-print-area screen-only'}>
            {(['hplc', 'endo', 'ster'] as const)
              .filter(d => orderSummary.counts[d] > 0)
              .map(d => (
                <div key={d} className="label-row">
                  <OrderLabelTemplate
                    orderNumber={orderSummary.order_number}
                    department={d}
                    vialCount={orderSummary.counts[d]}
                    orderDate={orderSummary.order_date}
                  />
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}
