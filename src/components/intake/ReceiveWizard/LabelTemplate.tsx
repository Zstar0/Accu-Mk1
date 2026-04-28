import { useEffect, useRef } from 'react'
import JsBarcode from 'jsbarcode'

interface Props {
  sampleId: string
}

export function LabelTemplate({ sampleId }: Props) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (ref.current) {
      JsBarcode(ref.current, sampleId, {
        format: 'CODE39',
        width: 1.4,
        height: 30,
        displayValue: false,
        margin: 0,
      })
    }
  }, [sampleId])
  return (
    <div className="label">
      <svg ref={ref} />
      <div className="label-id">{sampleId}</div>
    </div>
  )
}
