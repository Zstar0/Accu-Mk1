import { describe, it, expect } from 'vitest'
import { boxLabelLines } from '@/components/intake/ReceiveWizard/BoxStep'
import type { LimsBox } from '@/lib/api'

const box: LimsBox = {
  id: 1, order_key: 'WP-20066', box_number: 3, role: 'ster',
  label_code: 'WP-20066-3', vial_count: 4, printed_at: null,
  created_at: null, stored_at: null,
}

describe('boxLabelLines', () => {
  it('uses the label_code verbatim (no double WP- prefix) and names the bin', () => {
    const lines = boxLabelLines(box, 'RTD Biosciences')
    expect(lines[0]).toBe('WP-20066-3')
    expect(lines).toContain('RTD Biosciences')
    expect(lines.join(' ')).toMatch(/STER/i)
    expect(lines.join(' ')).toMatch(/4 vials/)
  })
})
