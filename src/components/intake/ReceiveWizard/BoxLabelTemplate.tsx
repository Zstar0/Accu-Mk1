import { QRCodeSVG } from 'qrcode.react'

// "PCR" per the lab's Sterility-Screening-PCR naming (matches the order label).
export const ROLE_SHORT: Record<string, string> = { hplc: 'HPLC', endo: 'ENDO', ster: 'PCR' }

interface Props {
  boxId: number                // lims_boxes.id — the QR payload (scanner-station contract)
  orderKey: string             // e.g. "WP-3267" — the big printed line
  role: 'hplc' | 'endo' | 'ster'
  vialCount: number
  createdAt: string | null     // ISO; printed as YYYY-MM-DD, omitted when null
}

export function BoxLabelTemplate({ boxId, orderKey, role, vialCount, createdAt }: Props) {
  return (
    <div className="label">
      {/* QR carries the bare numeric box id, NOT the label code: it must stay
          sparse enough to scan at 5.5mm on the 2"x1/4" strip, and bench
          stations append their own bench id when they call check-in. */}
      <QRCodeSVG value={String(boxId)} size={64} level="M" marginSize={2} />
      <div className="box-label-text">
        <div className="box-label-id">{orderKey}</div>
        <div className="box-label-meta">
          <span className="box-label-dept">
            {ROLE_SHORT[role]} · {vialCount} vial{vialCount === 1 ? '' : 's'}
          </span>
          {createdAt && <span className="box-label-date">{createdAt.slice(0, 10)}</span>}
        </div>
      </div>
    </div>
  )
}
