import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProductChip, ProductChipTooltip } from '@/components/senaite/ProductChip'
import type { OrderedProduct } from '@/lib/api'
import type { ProductCompletion } from '@/lib/product-completion'

const varianceProduct: OrderedProduct = {
  key: 'variance',
  label: 'Variance HPLC',
  is_addon: true,
  fulfillment_role: 'variance',
  fulfillment_dim: 'kind',
}

const hplcProduct: OrderedProduct = {
  key: 'hplcpurity_identity',
  label: 'HPLC',
  is_addon: false,
  fulfillment_role: null,
  fulfillment_dim: 'role',
}

describe('ProductChipTooltip', () => {
  it('renders the product label as the header', () => {
    render(<ProductChipTooltip product={hplcProduct} completion={null} />)
    const el = screen.getByTestId('product-chip-tooltip')
    expect(el.textContent ?? '').toContain('HPLC')
  })

  it('marks add-on products in the header', () => {
    render(<ProductChipTooltip product={varianceProduct} completion={null} />)
    expect(screen.getByTestId('product-chip-tooltip').textContent ?? '').toMatch(
      /Add-?on/i
    )
  })

  it('omits the add-on marker for base products', () => {
    render(<ProductChipTooltip product={hplcProduct} completion={null} />)
    expect(screen.getByTestId('product-chip-tooltip').textContent ?? '').not.toMatch(
      /Add-?on/i
    )
  })

  it('shows no completion status when no rule applies (completion null)', () => {
    render(<ProductChipTooltip product={hplcProduct} completion={null} />)
    const text = screen.getByTestId('product-chip-tooltip').textContent ?? ''
    expect(text).not.toMatch(/Complete|Pending/i)
  })

  it('shows Complete + "Locked vials" for a met variance product', () => {
    const completion: ProductCompletion = { met: true, vials: ['P-1001', 'P-1002'] }
    render(<ProductChipTooltip product={varianceProduct} completion={completion} />)
    const text = screen.getByTestId('product-chip-tooltip').textContent ?? ''
    expect(text).toContain('Complete')
    expect(text).toMatch(/Locked vials/i)
    expect(text).toContain('P-1001')
    expect(text).toContain('P-1002')
  })

  it('shows Complete + "Promoted from" for a met non-variance product', () => {
    const completion: ProductCompletion = { met: true, vials: ['P-2001'] }
    render(<ProductChipTooltip product={hplcProduct} completion={completion} />)
    const text = screen.getByTestId('product-chip-tooltip').textContent ?? ''
    expect(text).toContain('Complete')
    expect(text).toMatch(/Promoted from/i)
    expect(text).toContain('P-2001')
  })

  it('shows Pending and no vial ids when a rule exists but is unmet', () => {
    const completion: ProductCompletion = { met: false, vials: [] }
    render(<ProductChipTooltip product={hplcProduct} completion={completion} />)
    const text = screen.getByTestId('product-chip-tooltip').textContent ?? ''
    expect(text).toMatch(/Pending/i)
    expect(text).not.toContain('P-')
  })
})

describe('ProductChip', () => {
  it('renders the label and no longer sets a native title attribute', () => {
    const completion: ProductCompletion = { met: true, vials: ['P-1001'] }
    const { container } = render(
      <ProductChip product={varianceProduct} completion={completion} />
    )
    expect(screen.getAllByText('Variance HPLC').length).toBeGreaterThan(0)
    // The native `title=` tooltip is replaced by the styled hover card.
    expect(container.querySelector('[title]')).toBeNull()
  })
})
