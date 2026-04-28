import { QRCodeSVG } from 'qrcode.react'

interface Props {
  sampleId: string
  /** WP-XXXX style client order number, optional. */
  orderNumber?: string | null
}

export function LabelTemplate({ sampleId, orderNumber }: Props) {
  return (
    <div className="label">
      <QRCodeSVG
        value={sampleId}
        size={64}
        level="M"
        marginSize={0}
      />
      <div className="label-id">{sampleId}</div>
      {orderNumber && <div className="label-order">{orderNumber}</div>}
    </div>
  )
}
