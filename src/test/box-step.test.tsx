import { describe, it, expect } from 'vitest'
import { boxLabelLines } from '@/components/intake/ReceiveWizard/BoxStep'
import type { LimsBox, VialRoleRow } from '@/lib/api'

const box: LimsBox = {
  id: 1, order_key: 'WP-20066', box_number: 3, role: 'ster',
  label_code: 'BOX-20066-3', vial_count: 4, printed_at: null,
  created_at: '2026-07-01T12:00:00', stored_at: null,
}

// S1 roles-as-data: boxLabelLines resolves the short form from the catalog
// (roleShortLabel) — this fixture mirrors the seeded short_label values for
// the legacy roles so the pre-existing assertions below hold unchanged.
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

describe('boxLabelLines', () => {
  it('leads with the full box name (label_code)', () => {
    const lines = boxLabelLines(box, ROLES)
    expect(lines[0]).toBe('BOX-20066-3')
  })

  it('meta line: short role (ster → PCR) · vial count · created date', () => {
    const lines = boxLabelLines(box, ROLES)
    expect(lines[1]).toBe('PCR · 4 vials · 2026-07-01')
  })

  it('omits the date when created_at is null and singularizes one vial', () => {
    const lines = boxLabelLines({ ...box, role: 'hplc', vial_count: 1, created_at: null }, ROLES)
    expect(lines[1]).toBe('HPLC · 1 vial')
  })

  it('falls back to the uppercased code for a role the catalog has no entry for (prints T_ROLE, not "undefined")', () => {
    const lines = boxLabelLines({ ...box, role: 't_role', vial_count: 2, created_at: null }, ROLES)
    expect(lines[1]).toBe('T_ROLE · 2 vials')
  })
})
