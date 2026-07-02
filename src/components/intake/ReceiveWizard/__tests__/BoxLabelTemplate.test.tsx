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
      <BoxLabelTemplate boxId={137} orderKey="WP-3267" role="hplc" vialCount={4} createdAt={null} />,
    )
    expect(screen.getByTestId('qr').getAttribute('data-value')).toBe('137')
  })

  it('prints the order key as the big line (no box_number suffix)', () => {
    render(
      <BoxLabelTemplate boxId={137} orderKey="WP-3267" role="hplc" vialCount={4} createdAt={null} />,
    )
    expect(screen.getByText('WP-3267')).toBeInTheDocument()
  })

  it('meta row shows the short role and vial count — ster prints as PCR', () => {
    render(
      <BoxLabelTemplate boxId={137} orderKey="WP-3267" role="ster" vialCount={2} createdAt={null} />,
    )
    expect(screen.getByText('PCR · 2 vials')).toBeInTheDocument()
  })

  it('renders the box created date as YYYY-MM-DD', () => {
    render(
      <BoxLabelTemplate boxId={137} orderKey="WP-3267" role="hplc" vialCount={4}
        createdAt="2026-07-01T12:00:00" />,
    )
    expect(screen.getByText('2026-07-01')).toBeInTheDocument()
  })

  it('xtra prints as XTRA on the meta row', () => {
    render(
      <BoxLabelTemplate boxId={137} orderKey="WP-3267" role="xtra" vialCount={1} createdAt={null} />,
    )
    expect(screen.getByText('XTRA · 1 vial')).toBeInTheDocument()
  })

  it('singularizes a one-vial count', () => {
    render(
      <BoxLabelTemplate boxId={137} orderKey="WP-3267" role="endo" vialCount={1} createdAt={null} />,
    )
    expect(screen.getByText('ENDO · 1 vial')).toBeInTheDocument()
  })
})
