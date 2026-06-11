import { describe, it, expect } from 'vitest'
import { vialLabel, vialPosition, vialTotal } from '@/lib/vial-label'

describe('vialLabel', () => {
  it('container mode: S01 is Vial 1', () => {
    expect(vialLabel(1, true)).toBe('Vial 1')
    expect(vialLabel(6, true)).toBe('Vial 6')
  })
  it('legacy: parent is Vial 1, so S01 is Vial 2', () => {
    expect(vialLabel(1, false)).toBe('Vial 2')
    expect(vialLabel(6, false)).toBe('Vial 7')
  })
  it('vialPosition mirrors the numbering for print labels', () => {
    expect(vialPosition(1, true)).toBe(1)
    expect(vialPosition(1, false)).toBe(2)
  })
  it('vialTotal: legacy counts the parent, container does not', () => {
    expect(vialTotal(6, false)).toBe(7)
    expect(vialTotal(6, true)).toBe(6)
  })
})
