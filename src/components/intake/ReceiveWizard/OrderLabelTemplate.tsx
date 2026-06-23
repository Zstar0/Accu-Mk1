const DEPT_LABEL: Record<'hplc' | 'endo' | 'ster', string> = {
  hplc: 'HPLC',
  endo: 'ENDO',
  ster: 'PCR',
}

interface Props {
  orderNumber: string
  department: 'hplc' | 'endo' | 'ster'
  vialCount: number
  orderDate: string | null
}

export function OrderLabelTemplate({ orderNumber, department, vialCount, orderDate }: Props) {
  return (
    <div className="order-label">
      <div className="order-label-id">{orderNumber}</div>
      <div className="order-label-meta">
        <span className="order-label-dept">
          {DEPT_LABEL[department]} · {vialCount} vial{vialCount === 1 ? '' : 's'}
        </span>
        {orderDate && <span className="order-label-date">{orderDate}</span>}
      </div>
    </div>
  )
}
