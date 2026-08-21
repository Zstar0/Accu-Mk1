import { describe, it, expect } from 'vitest'
import { boxLabelLines } from '@/components/intake/ReceiveWizard/BoxStep'
import type { LimsBox } from '@/lib/api'

const box: LimsBox = {
  id: 1, order_key: 'WP-20066', box_number: 3, role: 'ster',
  label_code: 'BOX-20066-3', vial_count: 4, printed_at: null,
  created_at: '2026-07-01T12:00:00', stored_at: null,
}

describe('boxLabelLines', () => {
  it('leads with the full box name (label_code)', () => {
    const lines = boxLabelLines(box)
    expect(lines[0]).toBe('BOX-20066-3')
  })

  it('meta line: short role (ster → PCR) · vial count · created date', () => {
    const lines = boxLabelLines(box)
    expect(lines[1]).toBe('PCR · 4 vials · 2026-07-01')
  })

  it('omits the date when created_at is null and singularizes one vial', () => {
    const lines = boxLabelLines({ ...box, role: 'hplc', vial_count: 1, created_at: null })
    expect(lines[1]).toBe('HPLC · 1 vial')
  })

  it('falls back to the uppercased code for a role ROLE_SHORT has no entry for (prints T_ROLE, not "undefined")', () => {
    const lines = boxLabelLines({ ...box, role: 't_role', vial_count: 2, created_at: null })
    expect(lines[1]).toBe('T_ROLE · 2 vials')
  })
})
