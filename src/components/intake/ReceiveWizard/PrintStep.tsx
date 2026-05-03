import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { LabelTemplate } from './LabelTemplate'
import './PrintStep.css'

interface PrintLabel {
  /** sample_id is sufficient for label rendering — works for both the parent
   * AR (when checked in as a single-vial sample) and sub-samples. */
  sample_id: string
}

interface Props {
  vials: PrintLabel[]
  /** WP-XXXX style client order number, surfaced from useParentSampleDetails. */
  orderNumber?: string | null
  onDone: () => void
}

export function PrintStep({ vials, orderNumber, onDone }: Props) {
  useEffect(() => {
    // Auto-trigger the OS print dialog 200ms after mount so the page renders first.
    const t = setTimeout(() => window.print(), 200)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="p-6">
      <header className="screen-only flex justify-between items-center mb-4 gap-2">
        <h2 className="text-xl font-semibold">
          Print {vials.length} label{vials.length === 1 ? '' : 's'}
        </h2>
        <div className="flex gap-2">
          <Button
            type="button"
            onClick={() => window.print()}
            variant="default"
          >
            Print
          </Button>
          <Button
            type="button"
            onClick={onDone}
            variant="outline"
          >
            Skip — close
          </Button>
        </div>
      </header>

      <div className="print-area">
        {vials.map(v => (
          <LabelTemplate
            key={v.sample_id}
            sampleId={v.sample_id}
            orderNumber={orderNumber}
          />
        ))}
      </div>

      {vials.length === 0 && (
        <p className="text-muted-foreground screen-only">
          No vials in this session — nothing to print.
        </p>
      )}
    </div>
  )
}
