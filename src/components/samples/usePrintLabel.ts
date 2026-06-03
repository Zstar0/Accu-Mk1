import { useEffect, useState } from 'react'

interface PrintTarget {
  sampleId: string
  orderNumber?: string | null
  /** Check-in date for the label. Defaults to today inside LabelTemplate
   *  if omitted. */
  receivedAt?: string | Date | null
}

/**
 * Trigger an OS-level print with just a single label rendered.
 *
 * Usage:
 *   const { printLabel, target } = usePrintLabel()
 *   ...
 *   <button onClick={() => printLabel({ sampleId: 'P-XXX-S01', orderNumber: 'WP-1234' })}>Print Label</button>
 *   <PrintLabelPortal target={target} />
 *
 * The print CSS in PrintStep.css uses visibility-based isolation:
 *   body * { visibility: hidden }
 *   .print-area, .print-area * { visibility: visible }
 * — so the temporary .print-area we render here is the only thing the
 * browser prints, regardless of which page hosts it.
 */
export function usePrintLabel() {
  const [target, setTarget] = useState<PrintTarget | null>(null)

  useEffect(() => {
    if (!target) return
    // Give the SVG a tick to lay out before invoking print
    const t = setTimeout(() => window.print(), 80)
    const cleanup = () => setTarget(null)
    window.addEventListener('afterprint', cleanup, { once: true })
    return () => {
      clearTimeout(t)
      window.removeEventListener('afterprint', cleanup)
    }
  }, [target])

  const printLabel = (t: PrintTarget) => setTarget(t)

  return { printLabel, target }
}
