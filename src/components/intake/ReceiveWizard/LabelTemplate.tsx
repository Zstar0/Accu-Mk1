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

  // The strip label packs everything into one horizontal text row to fit the
  // 105.7mm × 8.5mm media: [Sample ID]  [Vial X/Y · WP-#### · Date: M/D/YYYY]  [ROLE]
  // Each segment is optional; separators only render when both neighbors exist.
  const metaParts: string[] = []
  if (hasVial) metaParts.push(`Vial ${vialPosition}/${vialTotal}`)
  if (orderNumber) metaParts.push(orderNumber)
  if (dateStr) metaParts.push(`Date: ${dateStr}`)

  return (
    <div className="label">
      <QRCodeSVG value={sampleId} size={96} level="M" marginSize={0} />
      <div className="label-text">
        <div className="label-id">{sampleId}</div>
        {metaParts.length > 0 && (
          <div className="label-meta">
            {metaParts.map((part, i) => (
              <span key={i}>
                {i > 0 && <span className="label-meta-sep">·</span>}
                {part}
              </span>
            ))}
          </div>
        )}
        {roleText && <div className="label-role">{roleText}</div>}
      </div>
    </div>
  )
}
