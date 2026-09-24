import { describe, it, expect } from 'vitest'
import { benchKindForItem, worksheetKind } from '@/lib/worksheet-kind'

const item = (
  role: string | null,
  keywords: (string | null)[] = []
): Parameters<typeof benchKindForItem>[0] => ({
  assignment_role: role,
  analyses: keywords.map(k => ({ keyword: k })),
})

describe('benchKindForItem', () => {
  it('reads the vial role first', () => {
    expect(benchKindForItem(item('endo'))).toBe('endo')
    expect(benchKindForItem(item('endo85'))).toBe('endo')
    expect(benchKindForItem(item('pcr'))).toBe('pcr')
    expect(benchKindForItem(item('ster'))).toBe('pcr')
    expect(benchKindForItem(item('usp71'))).toBe('sterility')
    expect(benchKindForItem(item('hm'))).toBe('hm')
    expect(benchKindForItem(item('hplc'))).toBe('hplc')
    expect(benchKindForItem(item('fentanyl'))).toBe('hplc')
  })

  it('falls back to the analyses for parent-sample items', () => {
    expect(benchKindForItem(item(null, ['ENDO-LAL']))).toBe('endo')
    expect(benchKindForItem(item(null, ['ENDOTOXIN-USP85LAL']))).toBe('endo')
    expect(benchKindForItem(item(null, ['STER-PCR']))).toBe('pcr')
    expect(benchKindForItem(item(null, ['STERILITY-PCR']))).toBe('pcr')
    expect(benchKindForItem(item(null, ['HPLC-PUR', 'ID_BPC']))).toBe('hplc')
    expect(benchKindForItem(item(null, [null]))).toBeNull()
  })
})

describe('worksheetKind', () => {
  it('is the single kind when every item agrees, else mixed', () => {
    expect(worksheetKind([item('endo85'), item(null, ['ENDO-LAL'])])).toBe(
      'endo'
    )
    expect(worksheetKind([item('pcr'), item('pcr')])).toBe('pcr')
    expect(worksheetKind([item('endo85'), item('pcr')])).toBe('mixed')
    expect(worksheetKind([])).toBeNull()
  })
})
