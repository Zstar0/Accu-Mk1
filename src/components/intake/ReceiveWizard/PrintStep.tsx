import { useEffect, useState } from 'react'
import { ArrowLeft, Check, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LabelTemplate } from './LabelTemplate'
import { getVialPlan, type VialPlanItem } from '@/lib/api'
import './PrintStep.css'

interface PrintLabel {
  sample_id: string
}

interface Props {
  parentSampleId: string
  vials: PrintLabel[]
  orderNumber?: string | null
  onDone: () => void
  onBack?: () => void
}

export function PrintStep({
  parentSampleId,
  vials,
  orderNumber,
  onDone,
  onBack,
}: Props) {
  const [planByVial, setPlanByVial] = useState<Record<string, VialPlanItem>>({})
  const [vialTotal, setVialTotal] = useState<number | null>(null)

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
      })
      .catch(() => {
        // intentional: print proceeds without role enrichment
      })
    return () => {
      cancelled = true
    }
  }, [parentSampleId])

  useEffect(() => {
    const t = setTimeout(() => window.print(), 200)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="grid grid-rows-[1fr_auto] h-full min-h-[500px]">
      <div className="overflow-y-auto p-6">
        <header className="screen-only mb-4">
          <h2 className="text-xl font-semibold">
            Print {vials.length} label{vials.length === 1 ? '' : 's'}
          </h2>
        </header>

        <div className="print-area">
          {vials.map(v => {
            const planItem = planByVial[v.sample_id]
            const role = planItem?.assignment_role ?? null
            // vial_sequence is 0-based on the backend; +1 for display
            const position = planItem ? planItem.vial_sequence + 1 : null
            return (
              <LabelTemplate
                key={v.sample_id}
                sampleId={v.sample_id}
                orderNumber={orderNumber}
                vialPosition={position}
                vialTotal={vialTotal}
                role={role}
              />
            )
          })}
        </div>

        {vials.length === 0 && (
          <p className="text-muted-foreground screen-only">
            No vials in this session — nothing to print.
          </p>
        )}
      </div>

      <footer className="screen-only flex justify-between gap-2 px-6 py-3 border-t bg-muted/20 transition-colors">
        {onBack ? (
          <Button type="button" variant="outline" onClick={onBack}>
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            Back
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => window.print()}>
            <Printer className="w-4 h-4" aria-hidden="true" />
            Print labels
          </Button>
          <Button type="button" onClick={onDone}>
            <Check className="w-4 h-4" aria-hidden="true" />
            Finished
          </Button>
        </div>
      </footer>
    </div>
  )
}
