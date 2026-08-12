import { useEffect, useRef, useState } from 'react'
import { Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { LabelTemplate } from './LabelTemplate'
import { getVialPlan, type VialPlanItem } from '@/lib/api'
import { OrderLabelTemplate } from './OrderLabelTemplate'
import { vialPosition } from '@/lib/vial-label'
import { useVialRoles } from '@/services/vial-roles'
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
  orderDate?: string | null
}

/**
 * Print Labels tab body. Auto-print on mount was removed when this became
 * a peer tab — printing is now an explicit click. Per-label checkboxes let
 * a tech skip any subset (a label that printed badly, a vial already labeled
 * from a previous session, etc.). Default is all checked since the dominant
 * case is "print everything I just captured".
 */
export function PrintStep({ parentSampleId, vials, orderNumber, orderDate }: Props) {
  const [planByVial, setPlanByVial] = useState<Record<string, VialPlanItem>>({})
  const [vialTotal, setVialTotal] = useState<number | null>(null)
  // Container family: position = vial_sequence (S01 IS Vial 1); legacy +1.
  const [containerMode, setContainerMode] = useState(false)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () => new Set(vials.map(v => v.sample_id)),
  )
  // Shape-driven (spec 4, Task 10 — the WizardHeader idiom): keyed by
  // whatever assignment_role codes the order's vials actually carry, not a
  // fixed hplc/endo/ster triple. A catalog-only role (e.g. hm) gets its own
  // order label without any code change here.
  const [orderCounts, setOrderCounts] = useState<Record<string, number> | null>(null)
  const [printMode, setPrintMode] = useState<'vials' | 'order'>('vials')
  // S1 roles-as-data: the one useVialRoles() call for this tree — LabelTemplate
  // is a print template and must not grow a query hook of its own, so its
  // catalog data is threaded through from here.
  const vialRolesQ = useVialRoles()

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

  // Box-label counts come from what's actually ASSIGNED — the vial plan's
  // per-vial assignment_role (any real catalog role; xtra/unassigned don't
  // count) — not what was ordered. A department with no vials assigned yet
  // prints no label; reprinting after more vials arrive and are assigned
  // reflects the new assignment. Guard against a double-click double-print
  // (physical labels are expensive — a stray second print dialog can waste a
  // label).
  const orderPrintInFlight = useRef(false)
  const printOrderLabels = () => {
    if (!orderNumber || orderPrintInFlight.current) return
    const counts: Record<string, number> = {}
    for (const v of Object.values(planByVial)) {
      const role = v.assignment_role
      if (!role || role === 'xtra' || role === 'unassigned') continue
      counts[role] = (counts[role] ?? 0) + 1
    }
    if (Object.values(counts).reduce((sum, n) => sum + n, 0) === 0) return // nothing assigned → no labels
    orderPrintInFlight.current = true
    setOrderCounts(counts)
    setPrintMode('order')
    // wait two frames so the order-label DOM mounts before printing
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.print()
        setPrintMode('vials')
        orderPrintInFlight.current = false
      }),
    )
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
            onClick={printOrderLabels}
            disabled={!orderNumber}
            className="gap-2"
          >
            <Printer className="w-4 h-4" aria-hidden="true" />
            Print Order #
          </Button>
          <Button
            type="button"
            onClick={() => window.print()}
            // vialRolesQ.isLoading: a physical label must never print the
            // uppercased-code fallback (e.g. "STER" instead of "PCR") because
            // the catalog hadn't resolved yet — same principle as BoxStep's
            // whole-render vialRolesQ.isLoading gate, scoped here to just the
            // print action since the rest of this screen (checkboxes, counts)
            // doesn't depend on role labels.
            disabled={selectedCount === 0 || vialRolesQ.isLoading}
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
                    roles={vialRolesQ.data}
                  />
                </div>
              )
            })}
          </div>
        )}
        {orderCounts && (
          <div className={printMode === 'order' ? 'print-area order-print-area' : 'order-print-area screen-only'}>
            {/* Sorted so a reprint never shuffles which physical strip
                corresponds to which role. */}
            {Object.keys(orderCounts)
              .filter(role => (orderCounts[role] ?? 0) > 0)
              .sort()
              .map(role => (
                <div key={role} className="label-row">
                  <OrderLabelTemplate
                    orderNumber={orderNumber ?? ''}
                    role={role}
                    vialCount={orderCounts[role] ?? 0}
                    orderDate={orderDate ? orderDate.slice(0, 10) : null}
                  />
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}
