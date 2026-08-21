import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BoxLabelTemplate } from '../BoxLabelTemplate'
import type { VialRoleRow } from '@/lib/api'

// The QR lib renders opaque SVG paths; stub it so the encoded value is assertable.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="qr" data-value={value} />,
}))

// S1 roles-as-data: BoxLabelTemplate is a print template — it takes an
// optional `roles` prop (no query hook of its own) and resolves the short
// form via roleShortLabel. This fixture mirrors the seeded short_label
// values for the legacy roles so the pre-existing assertions hold unchanged.
const vialRoleRow = (code: string, shortLabel: string): VialRoleRow => ({
  id: 1, code, label: code.toUpperCase(), department_id: 1, boxable: true,
  variance_eligible: true, sort_order: 0, frozen: true, is_system: true,
  short_label: shortLabel,
})

const ROLES: VialRoleRow[] = [
  vialRoleRow('hplc', 'HPLC'),
  vialRoleRow('endo', 'ENDO'),
  vialRoleRow('ster', 'PCR'),
  vialRoleRow('xtra', 'XTRA'),
]

describe('BoxLabelTemplate', () => {
  it('encodes the bare box id in the QR — the scanner-station contract', () => {
    render(
      <BoxLabelTemplate boxId={137} labelCode="BOX-3267-1" role="hplc" vialCount={4} createdAt={null} roles={ROLES} />,
    )
    expect(screen.getByTestId('qr').getAttribute('data-value')).toBe('137')
  })

  it('prints the full box name as the big line', () => {
    render(
      <BoxLabelTemplate boxId={137} labelCode="BOX-3267-1" role="hplc" vialCount={4} createdAt={null} roles={ROLES} />,
    )
    expect(screen.getByText('BOX-3267-1')).toBeInTheDocument()
  })

  it('meta row shows the short role and vial count — ster prints as PCR', () => {
    render(
      <BoxLabelTemplate boxId={137} labelCode="BOX-3267-1" role="ster" vialCount={2} createdAt={null} roles={ROLES} />,
    )
    expect(screen.getByText('PCR · 2 vials')).toBeInTheDocument()
  })

  it('renders the box created date as YYYY-MM-DD', () => {
    render(
      <BoxLabelTemplate boxId={137} labelCode="BOX-3267-1" role="hplc" vialCount={4}
        createdAt="2026-07-01T12:00:00" roles={ROLES} />,
    )
    expect(screen.getByText('2026-07-01')).toBeInTheDocument()
  })

  it('xtra prints as XTRA on the meta row', () => {
    render(
      <BoxLabelTemplate boxId={137} labelCode="BOX-3267-1" role="xtra" vialCount={1} createdAt={null} roles={ROLES} />,
    )
    expect(screen.getByText('XTRA · 1 vial')).toBeInTheDocument()
  })

  it('singularizes a one-vial count', () => {
    render(
      <BoxLabelTemplate boxId={137} labelCode="BOX-3267-1" role="endo" vialCount={1} createdAt={null} roles={ROLES} />,
    )
    expect(screen.getByText('ENDO · 1 vial')).toBeInTheDocument()
  })

  it('falls back to the uppercased code when no roles data is supplied (loading state)', () => {
    render(
      <BoxLabelTemplate boxId={137} labelCode="BOX-3267-1" role="t_role" vialCount={1} createdAt={null} />,
    )
    expect(screen.getByText('T_ROLE · 1 vial')).toBeInTheDocument()
  })
})
