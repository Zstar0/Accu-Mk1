import { describe, it, expect } from 'vitest'
import { needsMk1AnalysesSwap } from '@/lib/mk1-analyses-swap'

describe('needsMk1AnalysesSwap', () => {
  it('returns true for SENAITE-sourced analyses (hex uids, not yet swapped)', () => {
    const analyses = [
      { uid: 'a8c27e69bfa84ff1bf16a3e370a44456' },
      { uid: 'b3500a85f9d842ada35cf48c20399a1f' },
    ]
    expect(needsMk1AnalysesSwap(analyses)).toBe(true)
  })

  it('returns false once analyses are Mk1-sourced (every row mk1: prefixed)', () => {
    const analyses = [{ uid: 'mk1:668' }, { uid: 'mk1:817' }]
    expect(needsMk1AnalysesSwap(analyses)).toBe(false)
  })

  it('returns false for an empty list (nothing to swap, prevents loop)', () => {
    expect(needsMk1AnalysesSwap([])).toBe(false)
  })

  it('returns false when at least one row is already mk1: (swap already applied)', () => {
    // Mixed shouldn't occur in practice, but a present mk1: row means the
    // swap ran — don't re-trigger it.
    const analyses = [{ uid: 'mk1:668' }, { uid: 'a8c27e69bfa84ff1bf16a3e370a44456' }]
    expect(needsMk1AnalysesSwap(analyses)).toBe(false)
  })

  it('treats null/undefined uids as non-Mk1 (still needs swap)', () => {
    expect(needsMk1AnalysesSwap([{ uid: null }, { uid: undefined }])).toBe(true)
  })
})
