import { QRCodeSVG } from 'qrcode.react'

const ROLE_SHORT: Record<string, string> = { hplc: 'HPLC', endo: 'ENDO', ster: 'STERYL' }

interface Props {
  labelCode: string            // e.g. "WP-20066-3" (verbatim; never prefixed)
  clientName: string | null
  role: 'hplc' | 'endo' | 'ster'
  vialCount: number
}

export function BoxLabelTemplate({ labelCode, clientName, role, vialCount }: Props) {
  return (
    <div className="label">
      <QRCodeSVG value={labelCode} size={96} level="M" marginSize={0} />
      <div className="label-text">
        <div className="label-id">{labelCode}</div>
        <div className="label-meta">
          {clientName && <span>{clientName}</span>}
          <span className="label-meta-sep">·</span>
          <span>{vialCount} vials</span>
        </div>
        <div className="label-role">{ROLE_SHORT[role]}</div>
      </div>
    </div>
  )
}
