import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BoxLabelTemplate } from '../BoxLabelTemplate'

// The QR lib renders opaque SVG paths; stub it so the encoded value is assertable.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="qr" data-value={value} />,
}))

describe('BoxLabelTemplate', () => {
  it('encodes the bare box id in the QR — the scanner-station contract', () => {
    render(
      <BoxLabelTemplate boxId={137} labelCode="WP-3267-1" clientName="Acme" role="hplc" vialCount={4} />,
    )
    expect(screen.getByTestId('qr').getAttribute('data-value')).toBe('137')
  })

  it('still prints the human label code as text', () => {
    render(
      <BoxLabelTemplate boxId={137} labelCode="WP-3267-1" clientName={null} role="ster" vialCount={2} />,
    )
    expect(screen.getByText('WP-3267-1')).toBeInTheDocument()
  })
})
