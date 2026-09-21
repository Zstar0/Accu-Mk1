import { describe, it, expect } from 'vitest'
import {
  indexPromotions,
  mk1RowId,
  promotionForRow,
} from '@/lib/promotion-index'
import { computeProductCompletion } from '@/lib/product-completion'
import {
  buildBulkParentRetestImpact,
  resolvePromotedSourceParentState,
} from '@/lib/native-parent-analyses'
import type {
  OrderedProduct,
  ParentPromotionInfo,
  SenaiteAnalysis,
} from '@/lib/api'

const promo = (
  parent_analysis_id: number,
  keyword: string,
  vial: string
): ParentPromotionInfo => ({
  keyword,
  parent_analysis_id,
  promoted_at: '',
  sources: [{ sample_id: vial, contribution_kind: 'chosen' }],
})

/** Parent-tier purity rows of a 3-peptide native blend: one generic keyword,
 *  one row per slot. */
const purity = (id: number, slot: number) =>
  ({
    uid: `mk1:${id}`,
    keyword: 'HPLC-PURITY',
    slot,
    title: `slot ${slot} purity`,
    review_state: 'verified',
    service_group_name: 'Core HPLC',
  }) as unknown as SenaiteAnalysis

const rows = [purity(11, 1), purity(12, 2), purity(13, 3)]

describe('mk1RowId', () => {
  it('parses a native uid and rejects a SENAITE hex uid', () => {
    expect(mk1RowId('mk1:669')).toBe(669)
    expect(mk1RowId('a8c27e69bfa84ff1bf16a3e370a44456')).toBeNull()
    expect(mk1RowId(null)).toBeNull()
  })
})

describe('promotionForRow', () => {
  it('joins each blend slot to ITS OWN promotion by id', () => {
    const index = indexPromotions([
      promo(11, 'HPLC-PURITY', 'PB-1-S01'),
      promo(12, 'HPLC-PURITY', 'PB-1-S02'),
    ])
    expect(promotionForRow(index, rows[0]!)?.sources[0]?.sample_id).toBe('PB-1-S01')
    expect(promotionForRow(index, rows[1]!)?.sources[0]?.sample_id).toBe('PB-1-S02')
  })

  it('an unpromoted slot never borrows a sibling slot by keyword', () => {
    const index = indexPromotions([promo(11, 'HPLC-PURITY', 'PB-1-S01')])
    expect(promotionForRow(index, rows[2]!)).toBeUndefined()
  })

  it('a SENAITE row (no Mk1 id) keeps the keyword join', () => {
    const index = indexPromotions([promo(40, 'ENDO-LAL', 'P-1-S01')])
    const senaite = { uid: 'a8c27e69bfa84ff1bf16a3e370a44456', keyword: 'ENDO-LAL', slot: null }
    expect(promotionForRow(index, senaite)?.parent_analysis_id).toBe(40)
  })

  it('a slot-less native row falls back to keyword when the id misses', () => {
    const index = indexPromotions([promo(40, 'ENDO-LAL', 'P-1-S01')])
    expect(
      promotionForRow(index, { uid: 'mk1:99', keyword: 'ENDO-LAL', slot: null })
    ).toBeDefined()
  })
})

describe('blend consumers', () => {
  // The native HPLC package key; keywordFamilies is how the live page maps
  // native keywords to it (profile membership).
  const hplc = { key: 'hplc-purity-identity', label: 'HPLC', is_addon: false } as OrderedProduct
  const keywordFamilies = new Map([['HPLC-PURITY', 'hplc-purity-identity']])

  it('one promoted slot no longer marks the whole HPLC product complete', () => {
    const ctx = {
      analyses: rows,
      promotions: indexPromotions([promo(11, 'HPLC-PURITY', 'PB-1-S01')]),
      varianceSet: undefined,
      keywordFamilies,
    }
    expect(computeProductCompletion(hplc, ctx)?.met).toBe(false)
  })

  it('all three slots promoted: complete', () => {
    const ctx = {
      analyses: rows,
      promotions: indexPromotions([
        promo(11, 'HPLC-PURITY', 'PB-1-S01'),
        promo(12, 'HPLC-PURITY', 'PB-1-S01'),
        promo(13, 'HPLC-PURITY', 'PB-1-S01'),
      ]),
      varianceSet: undefined,
      keywordFamilies,
    }
    expect(computeProductCompletion(hplc, ctx)).toEqual({ met: true, vials: ['PB-1-S01'] })
  })

  it("retest blast radius names the target slot's own source vial", () => {
    const index = indexPromotions([
      promo(11, 'HPLC-PURITY', 'PB-1-S01'),
      promo(12, 'HPLC-PURITY', 'PB-1-S02'),
    ])
    expect(buildBulkParentRetestImpact([rows[0]!], index).vialIds).toEqual(['PB-1-S01'])
  })

  it("a vial row resolves its OWN parent's state, not the newest same-keyword row", () => {
    const parents = [
      { ...purity(11, 1), review_state: 'published' },
      { ...purity(12, 2), review_state: 'verified' },
    ] as SenaiteAnalysis[]
    expect(resolvePromotedSourceParentState(parents, 'HPLC-PURITY', 11)).toBe('published')
    // No id (legacy caller): keyword-newest, as before.
    expect(resolvePromotedSourceParentState(parents, 'HPLC-PURITY')).toBe('verified')
  })
})
