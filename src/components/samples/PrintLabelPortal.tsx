import { LabelTemplate } from '@/components/intake/ReceiveWizard/LabelTemplate'
import '@/components/intake/ReceiveWizard/PrintStep.css'

interface Props {
  target: { sampleId: string; orderNumber?: string | null } | null
}

/**
 * Off-screen container for a single label. Rendered while a print is
 * in-flight and removed once the user dismisses the print dialog.
 *
 * `position: fixed; left: -9999px` keeps it off-screen for normal viewing.
 * The print CSS overrides position to `fixed; left: 0; top: 0` so the
 * label lands on the printed page.
 */
export function PrintLabelPortal({ target }: Props) {
  if (!target) return null
  return (
    <div className="print-area" style={{ position: 'fixed', left: '-9999px', top: 0 }}>
      <LabelTemplate sampleId={target.sampleId} orderNumber={target.orderNumber} />
    </div>
  )
}
