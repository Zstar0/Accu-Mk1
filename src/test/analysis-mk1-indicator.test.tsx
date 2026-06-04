import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Mk1NativeBadge } from '@/components/senaite/AnalysisTable'

describe('Mk1NativeBadge', () => {
  it('renders the Mk1 icon + tooltip for an mk1: uid', () => {
    const { container, getByLabelText } = render(<Mk1NativeBadge uid="mk1:669" />)
    // icon present via aria-label
    expect(getByLabelText('Stored in Accu-Mk1')).toBeTruthy()
    // tooltip on the wrapping span
    expect(
      container.querySelector('[title="Stored in Accu-Mk1 (no SENAITE record)"]'),
    ).toBeTruthy()
  })

  it('renders nothing for a SENAITE hex uid', () => {
    const { container } = render(<Mk1NativeBadge uid="a8c27e69bfa84ff1bf16a3e370a44456" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for an undefined uid', () => {
    const { container } = render(<Mk1NativeBadge uid={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for a null uid', () => {
    const { container } = render(<Mk1NativeBadge uid={null} />)
    expect(container.firstChild).toBeNull()
  })
})
