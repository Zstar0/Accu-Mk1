import { QRCodeSVG } from 'qrcode.react'
import { roleShortLabel } from '@/lib/role-display'
import type { VialRoleRow } from '@/lib/api'

interface Props {
  boxId: number                // lims_boxes.id — the QR payload (scanner-station contract)
  labelCode: string            // e.g. "BOX-3267-1" — the big printed line
  // Widened to string (spec 4, Task 10): boxing is catalog-driven now, not
  // limited to the four legacy roles. See roleShortLabel's fallback.
  role: string
  vialCount: number
  createdAt: string | null     // ISO; printed as YYYY-MM-DD, omitted when null
  // S1 roles-as-data: this is a PRINT template — no query hook of its own.
  // The parent (BoxStep, which already owns useVialRoles()) threads its
  // catalog data straight through. Undefined while loading/absent — falls
  // back to the uppercased code, never "undefined" on a physical label.
  roles?: VialRoleRow[]
}

export function BoxLabelTemplate({ boxId, labelCode, role, vialCount, createdAt, roles }: Props) {
  return (
    <div className="label">
      {/* QR carries the bare numeric box id, NOT the label code: it must stay
          sparse enough to scan at 5.5mm on the 2"x1/4" strip, and bench
          stations append their own bench id when they call check-in. */}
      <QRCodeSVG value={String(boxId)} size={64} level="M" marginSize={2} />
      <div className="box-label-text">
        <div className="box-label-id">{labelCode}</div>
        <div className="box-label-meta">
          <span className="box-label-dept">
            {roleShortLabel(role, roles)} · {vialCount} vial{vialCount === 1 ? '' : 's'}
          </span>
          {createdAt && <span className="box-label-date">{createdAt.slice(0, 10)}</span>}
        </div>
      </div>
    </div>
  )
}
