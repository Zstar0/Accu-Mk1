import { describe, it, expect } from 'vitest'
import { formatNumericResult } from '@/components/senaite/senaite-utils'

// Surgical display-layer rounding: promoted sub-sample values land at full
// precision (e.g. Fill Volume 9.710267415 mL). The sample-details row should
// show 2 dp WITHOUT touching the stored value or restyling results that are
// already <= 2 dp. Only over-precise numeric values are trimmed.
describe('formatNumericResult', () => {
  it('trims an over-precise value to 2 dp', () => {
    expect(formatNumericResult('9.710267415')).toBe('9.71')
  })

  it('leaves a 2 dp value unchanged', () => {
    expect(formatNumericResult('6.89')).toBe('6.89')
  })

  it('leaves a 1 dp value unchanged (no forced trailing zero)', () => {
    expect(formatNumericResult('98.5')).toBe('98.5')
  })

  it('leaves an integer unchanged', () => {
    expect(formatNumericResult('5')).toBe('5')
  })

  it('passes through non-numeric text', () => {
    expect(formatNumericResult('Conforms')).toBe('Conforms')
  })

  it('passes through a value that carries a unit suffix', () => {
    expect(formatNumericResult('9.710267415 mL')).toBe('9.710267415 mL')
  })

  it('returns null for null', () => {
    expect(formatNumericResult(null)).toBeNull()
  })

  it('returns empty string for empty string', () => {
    expect(formatNumericResult('')).toBe('')
  })

  it('rounds half-up at the 2 dp boundary', () => {
    expect(formatNumericResult('0.125')).toBe('0.13')
  })
})
