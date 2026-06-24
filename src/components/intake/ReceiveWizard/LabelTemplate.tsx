import { QRCodeSVG } from 'qrcode.react'

const ROLE_SHORT: Record<string, string> = {
  hplc: 'HPLC',
  endo: 'ENDO',
  ster: 'PCR',
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
  /** Role from assignment step. If present, renders inline. */
  role?: 'hplc' | 'endo' | 'ster' | 'xtra' | null
  /** Check-in date — ISO string, Date, or null. Falls back to "today" so
   *  every printed label carries a date even when caller doesn't provide one. */
  receivedAt?: string | Date | null
}

function formatLabelDate(input: string | Date | null | undefined): string {
  const d = input ? new Date(input) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  // M/D/YYYY — the explicit format the lab tech asked for on the strip label.
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
}

export function LabelTemplate({
  sampleId,
  orderNumber,
  vialPosition,
  vialTotal,
  role,
  receivedAt,
}: Props) {
  const roleText = role ? ROLE_SHORT[role] : null
  const hasVial = vialPosition && vialTotal
  const dateStr = formatLabelDate(receivedAt)

  // 2" × 1/4" (50.8mm × 6.35mm) strip: QR on the left, two stacked text rows
  // on the right.
  //   Row 1: [Sample ID]                       [ROLE]
  //   Row 2: [Vial X/Y · WP-####]              [M/D/YYYY]
  // The role sits top-right and the date below it, per the lab tech's request.
  const subParts: string[] = []
  if (hasVial) subParts.push(`Vial ${vialPosition}/${vialTotal}`)
  if (orderNumber) subParts.push(orderNumber)

  return (
    <div className="label">
      <QRCodeSVG value={sampleId} size={64} level="M" marginSize={2} />
      <div className="label-text">
        <div className="label-line">
          <span className="label-id">{sampleId}</span>
          {roleText && <span className="label-role">{roleText}</span>}
        </div>
        <div className="label-line">
          {subParts.length > 0 && (
            <span className="label-sub">
              {subParts.map((part, i) => (
                <span key={i}>
                  {i > 0 && <span className="label-meta-sep">·</span>}
                  {part}
                </span>
              ))}
            </span>
          )}
          {dateStr && <span className="label-date">{dateStr}</span>}
        </div>
      </div>
    </div>
  )
}
