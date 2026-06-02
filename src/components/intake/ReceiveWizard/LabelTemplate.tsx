import { QRCodeSVG } from 'qrcode.react'

const ROLE_SHORT: Record<string, string> = {
  hplc: 'HPLC',
  endo: 'ENDO',
  ster: 'STERYL',
  xtra: 'XTRA',
}

interface Props {
  sampleId: string
  /** WP-XXXX style client order number, optional. */
  orderNumber?: string | null
  /** 1-based vial position within this parent's vial set; optional. */
  vialPosition?: number | null
  /** Total vials in this parent's set (parent + sub-samples); optional. */
  vialTotal?: number | null
  /** Role from assignment step. If present, renders as 3rd line. */
  role?: 'hplc' | 'endo' | 'ster' | 'xtra' | null
}

export function LabelTemplate({ sampleId, orderNumber, vialPosition, vialTotal, role }: Props) {
  const roleText = role ? ROLE_SHORT[role] : null
  const hasVial = vialPosition && vialTotal
  // The second line carries order # and vial position, independently. Either
  // (or both) may render — order # alone for the parent of a single-vial
  // family with no role, vial # alone when no client order # is on file.
  const showSecondLine = orderNumber || hasVial
  return (
    <div className="label">
      <QRCodeSVG value={sampleId} size={96} level="M" marginSize={0} />
      <div className="label-text">
        <div className="label-id">{sampleId}</div>
        {showSecondLine && (
          <div className="label-order">
            {orderNumber}
            {orderNumber && hasVial && ' · '}
            {hasVial && `Vial ${vialPosition}/${vialTotal}`}
          </div>
        )}
        {roleText && <div className="label-role">{roleText}</div>}
      </div>
    </div>
  )
}
