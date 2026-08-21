import { describe, it, expect } from 'vitest'
import { pickerSourceFor } from '@/lib/manage-analyses-picker'

describe('pickerSourceFor', () => {
  it('is native only on mk1 vial pages', () => {
    expect(pickerSourceFor('P-1', 'mk1://abc')).toBe('native')
    expect(pickerSourceFor('P-1', 'senaite-uid')).toBe('senaite')
    expect(pickerSourceFor(null, 'mk1://abc')).toBe('senaite') // parent pages keep the SENAITE picker
    expect(pickerSourceFor('P-1', undefined)).toBe('senaite')
  })
})
