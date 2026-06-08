import { describe, it, expect } from 'vitest'
import {
  itemBench,
  analysisRole,
  itemRoleBadges,
  vialHasMicroCategory,
  vialMatchesSampleId,
  vialMatchesAnalyte,
  MICRO_CATEGORIES,
} from '@/lib/inbox-filters'

describe('itemBench', () => {
  it('maps service group ids to benches', () => {
    expect(itemBench(1)).toBe('hplc')
    expect(itemBench(2)).toBe('micro')
    expect(itemBench(null)).toBeNull()
    expect(itemBench(99)).toBeNull()
  })
})

describe('analysisRole', () => {
  it('classifies by keyword first', () => {
    expect(analysisRole({ keyword: 'ENDO-LAL', title: 'Endotoxin' })).toBe('endo')
    expect(analysisRole({ keyword: 'STER-PCR', title: 'Rapid Sterility Screening (PCR)' })).toBe('ster')
  })
  it('falls back to title substring when keyword is null', () => {
    expect(analysisRole({ keyword: null, title: 'Endotoxin (LAL)' })).toBe('endo')
    expect(analysisRole({ keyword: null, title: 'Sterility check' })).toBe('ster')
  })
  it('treats peptide analyses as hplc', () => {
    expect(analysisRole({ keyword: 'BPC-157-PUR', title: 'Purity', peptide_name: 'BPC-157' })).toBe('hplc')
  })
  it('returns null for moisture / unclassifiable', () => {
    expect(analysisRole({ keyword: 'KF', title: 'Moisture Content' })).toBeNull()
    expect(analysisRole({ keyword: null, title: null })).toBeNull()
  })
})

describe('itemRoleBadges', () => {
  it('hplc item -> [hplc] regardless of analyses', () => {
    expect(itemRoleBadges({ service_group_id: 1, analyses: [{ keyword: 'X', title: 'Purity' }] })).toEqual(['hplc'])
  })
  it('endo-only micro item -> [endo]', () => {
    expect(itemRoleBadges({ service_group_id: 2, analyses: [{ keyword: 'ENDO-LAL', title: 'Endotoxin' }] })).toEqual(['endo'])
  })
  it('ster-only micro item -> [ster]', () => {
    expect(itemRoleBadges({ service_group_id: 2, analyses: [{ keyword: 'STER-PCR', title: 'Rapid Sterility Screening (PCR)' }] })).toEqual(['ster'])
  })
  it('mixed micro item -> [endo, ster] in stable order', () => {
    expect(itemRoleBadges({ service_group_id: 2, analyses: [
      { keyword: 'STER-PCR', title: 'Rapid Sterility Screening (PCR)' },
      { keyword: 'ENDO-LAL', title: 'Endotoxin' },
    ] })).toEqual(['endo', 'ster'])
  })
  it('micro item with only moisture -> [] (no pill)', () => {
    expect(itemRoleBadges({ service_group_id: 2, analyses: [{ keyword: 'KF', title: 'Moisture Content' }] })).toEqual([])
  })
  it('null group + no derivable role -> []', () => {
    expect(itemRoleBadges({ service_group_id: null, analyses: [] })).toEqual([])
  })
})

describe('vialHasMicroCategory', () => {
  const vial = { sample_id: 'P-0142', analyses: [
    { keyword: 'STER-PCR', title: 'Rapid Sterility Screening (PCR)' },
    { keyword: 'KF', title: 'Moisture Content' },
  ] }
  it('matches by keyword', () => {
    expect(vialHasMicroCategory(vial, 'ster')).toBe(true)
    expect(vialHasMicroCategory(vial, 'moisture')).toBe(true)
  })
  it('returns false when absent', () => {
    expect(vialHasMicroCategory(vial, 'endo')).toBe(false)
  })
  it('returns false for unknown category value', () => {
    expect(vialHasMicroCategory(vial, 'nope')).toBe(false)
  })
  it('exposes three categories', () => {
    expect(MICRO_CATEGORIES.map(c => c.value)).toEqual(['endo', 'ster', 'moisture'])
  })
})

describe('vialMatchesSampleId', () => {
  const vial = { sample_id: 'P-0142-S03', analyses: [] }
  it('case-insensitive substring on sample_id', () => {
    expect(vialMatchesSampleId(vial, 's03')).toBe(true)
    expect(vialMatchesSampleId(vial, '0142')).toBe(true)
    expect(vialMatchesSampleId(vial, 'X999')).toBe(false)
  })
})

describe('vialMatchesAnalyte', () => {
  const vial = { sample_id: 'P-1', analyses: [
    { keyword: 'BPC-PUR', title: 'Purity', peptide_name: 'BPC-157' },
    { keyword: 'X', title: 'Heavy Metals', peptide_name: null },
  ] }
  it('matches peptide_name', () => {
    expect(vialMatchesAnalyte(vial, 'bpc')).toBe(true)
  })
  it('matches title', () => {
    expect(vialMatchesAnalyte(vial, 'heavy')).toBe(true)
  })
  it('no match -> false', () => {
    expect(vialMatchesAnalyte(vial, 'zzz')).toBe(false)
  })
  it('empty query -> true (no constraint)', () => {
    expect(vialMatchesAnalyte(vial, '  ')).toBe(true)
  })
})
