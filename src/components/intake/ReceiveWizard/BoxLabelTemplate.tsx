import { QRCodeSVG } from 'qrcode.react'

const ROLE_SHORT: Record<string, string> = { hplc: 'HPLC', endo: 'ENDO', ster: 'STERYL' }

interface Props {
  boxId: number                // lims_boxes.id — the QR payload (scanner-station contract)
  labelCode: string            // e.g. "WP-20066-3" (verbatim; never prefixed)
  clientName: string | null
  role: 'hplc' | 'endo' | 'ster'
  vialCount: number
}

export function BoxLabelTemplate({ boxId, labelCode, clientName, role, vialCount }: Props) {
  return (
    <div className="label">
      {/* QR carries the bare numeric box id, NOT the label code: it must stay
          sparse enough to scan at 5.5mm on the 2"x1/4" strip, and bench
          stations append their own bench id when they call check-in. */}
      <QRCodeSVG value={String(boxId)} size={64} level="M" marginSize={2} />
      <div className="label-text">
        <div className="label-line">
          <span className="label-id">{labelCode}</span>
          <span className="label-role">{ROLE_SHORT[role]}</span>
        </div>
        <div className="label-line">
          <span className="label-sub">
            {clientName && (
              <>
                <span>{clientName}</span>
                <span className="label-meta-sep">·</span>
              </>
            )}
            <span>{vialCount} vials</span>
          </span>
        </div>
      </div>
    </div>
  )
}
