// Widened to string (spec 4, Task 10): counts are now shape-driven off
// whatever roles the order actually demanded (any catalog role, not just
// hplc/endo/ster) — see PrintStep's printOrderLabels. Falls back to the
// uppercased code for a role with no short-name entry here.
const DEPT_LABEL: Record<string, string> = {
  hplc: 'HPLC',
  endo: 'ENDO',
  ster: 'PCR',
}

interface Props {
  orderNumber: string
  // Renamed from `department` (spec 4, Task 10): this always was a ROLE code
  // (hplc/endo/ster, now any vial_roles code), not a department — the old
  // name collided with the catalog's actual Department concept.
  role: string
  vialCount: number
  orderDate: string | null
}

export function OrderLabelTemplate({ orderNumber, role, vialCount, orderDate }: Props) {
  return (
    <div className="order-label">
      <div className="order-label-id">{orderNumber}</div>
      <div className="order-label-meta">
        <span className="order-label-dept">
          {DEPT_LABEL[role] ?? role.toUpperCase()} · {vialCount} vial{vialCount === 1 ? '' : 's'}
        </span>
        {orderDate && <span className="order-label-date">{orderDate}</span>}
      </div>
    </div>
  )
}
