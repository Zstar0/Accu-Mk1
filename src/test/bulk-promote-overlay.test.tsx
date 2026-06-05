import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor, screen } from '@testing-library/react'
import {
  isPromotable,
  visibleRowTransitions,
  deriveBulkActions,
  deriveBulkPromoteBlockers,
  BulkPromoteDialog,
} from '@/components/senaite/AnalysisTable'
import type { SenaiteAnalysis } from '@/lib/api'
import * as api from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, promoteAnalyses: vi.fn().mockResolvedValue({}) }
})

const base: Partial<SenaiteAnalysis> = {
  title: 'Rapid Sterility Screening (PCR)',
  keyword: 'STER-PCR',
  result: '11',
}

function mk(overrides: Partial<SenaiteAnalysis>): SenaiteAnalysis {
  return { ...base, ...overrides } as SenaiteAnalysis
}

const promotable = mk({ uid: 'mk1:820', review_state: 'to_be_verified', promoted_to_parent_id: null })
const senaiteTbv = mk({ uid: 'a8c27e69bfa84ff1bf16a3e370a44456', review_state: 'to_be_verified' })

describe('isPromotable', () => {
  it('true for mk1 uid + to_be_verified + unpromoted', () => {
    expect(isPromotable(promotable)).toBe(true)
  })
  it('false for SENAITE uid', () => {
    expect(isPromotable(senaiteTbv)).toBe(false)
  })
  it('false for wrong state', () => {
    expect(isPromotable(mk({ uid: 'mk1:820', review_state: 'verified' }))).toBe(false)
  })
  it('false when already promoted', () => {
    expect(
      isPromotable(mk({ uid: 'mk1:820', review_state: 'to_be_verified', promoted_to_parent_id: 1260 })),
    ).toBe(false)
  })
  it('isPromotable returns false for null uid', () => {
    expect(isPromotable(mk({ uid: null, review_state: 'to_be_verified' }))).toBe(false)
  })
})

describe('visibleRowTransitions', () => {
  it('drops verify on a promotable row, keeps escape hatches', () => {
    const t = visibleRowTransitions(promotable)
    expect(t).not.toContain('verify')
    expect(t).toContain('retract')
  })
  it('keeps verify on a SENAITE to_be_verified row', () => {
    expect(visibleRowTransitions(senaiteTbv)).toContain('verify')
  })
  it('still gates submit on having a result', () => {
    const unsubmitted = mk({ uid: 'mk1:9', review_state: 'unassigned', result: null })
    expect(visibleRowTransitions(unsubmitted)).not.toContain('submit')
  })
  it('visibleRowTransitions returns [] for null uid', () => {
    expect(visibleRowTransitions(mk({ uid: null, review_state: 'to_be_verified' }))).toEqual([])
  })
})

describe('deriveBulkActions', () => {
  it('all-promotable selection: no verify, showPromote true', () => {
    const r = deriveBulkActions([promotable, mk({ uid: 'mk1:821', review_state: 'to_be_verified', keyword: 'ENDO' })])
    expect(r.actions).not.toContain('verify')
    expect(r.showPromote).toBe(true)
  })
  it('mixed selection (promotable + SENAITE): no verify, no promote', () => {
    const r = deriveBulkActions([promotable, senaiteTbv])
    expect(r.actions).not.toContain('verify')
    expect(r.showPromote).toBe(false)
  })
  it('pure SENAITE selection keeps verify', () => {
    const r = deriveBulkActions([senaiteTbv])
    expect(r.actions).toContain('verify')
    expect(r.showPromote).toBe(false)
  })
  it('empty selection: nothing', () => {
    const r = deriveBulkActions([])
    expect(r.actions).toEqual([])
    expect(r.showPromote).toBe(false)
  })
  it('deriveBulkActions excludes null-review_state rows from all actions', () => {
    const r = deriveBulkActions([mk({ uid: 'mk1:1', review_state: null })])
    expect(r.actions).toEqual([])
    expect(r.showPromote).toBe(false)
  })
})

describe('deriveBulkPromoteBlockers', () => {
  it('no blockers for distinct keywords with results', () => {
    expect(
      deriveBulkPromoteBlockers([promotable, mk({ uid: 'mk1:821', review_state: 'to_be_verified', keyword: 'ENDO' })]),
    ).toEqual([])
  })
  it('flags missing result', () => {
    const blockers = deriveBulkPromoteBlockers([mk({ uid: 'mk1:9', review_state: 'to_be_verified', result: null })])
    expect(blockers.some(b => b.includes('no result'))).toBe(true)
  })
  it('flags duplicate keywords', () => {
    const blockers = deriveBulkPromoteBlockers([
      promotable,
      mk({ uid: 'mk1:9', review_state: 'to_be_verified', keyword: 'STER-PCR' }),
    ])
    expect(blockers.some(b => b.includes('STER-PCR'))).toBe(true)
  })
  it('flags rows with no keyword', () => {
    const blockers = deriveBulkPromoteBlockers([mk({ uid: 'mk1:9', review_state: 'to_be_verified', keyword: null })])
    expect(blockers.some(b => b.includes('no keyword'))).toBe(true)
  })
})

describe('BulkPromoteDialog', () => {
  beforeEach(() => {
    vi.mocked(api.promoteAnalyses).mockClear().mockResolvedValue({} as never)
  })

  it('lists keyword and value per row, read-only', () => {
    render(
      <BulkPromoteDialog
        analyses={[promotable, mk({ uid: 'mk1:821', review_state: 'to_be_verified', keyword: 'ENDO', result: '0.4' })]}
        open
        onOpenChange={() => {}}
        onPromoted={() => {}}
      />,
    )
    expect(screen.getByText('STER-PCR')).toBeTruthy()
    expect(screen.getByText('11')).toBeTruthy()
    expect(screen.getByText('ENDO')).toBeTruthy()
    expect(screen.getByText('0.4')).toBeTruthy()
  })

  it('shows blocker and disables confirm when a result is missing', () => {
    render(
      <BulkPromoteDialog
        analyses={[mk({ uid: 'mk1:9', review_state: 'to_be_verified', result: null })]}
        open
        onOpenChange={() => {}}
        onPromoted={() => {}}
      />,
    )
    expect(screen.getByText(/no result/)).toBeTruthy()
    expect((screen.getByRole('button', { name: /^Promote \d/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('promotes each row sequentially then fires onPromoted', async () => {
    const onPromoted = vi.fn()
    render(
      <BulkPromoteDialog
        analyses={[promotable, mk({ uid: 'mk1:821', review_state: 'to_be_verified', keyword: 'ENDO', result: '0.4' })]}
        open
        onOpenChange={() => {}}
        onPromoted={onPromoted}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^Promote 2/ }))
    await waitFor(() => expect(onPromoted).toHaveBeenCalled())
    expect(vi.mocked(api.promoteAnalyses)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.promoteAnalyses)).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: 'STER-PCR', result_value: '11', reason: 'Bulk promote from AnalysisTable' }),
    )
    const calls = vi.mocked(api.promoteAnalyses).mock.calls
    expect(calls[0]![0].keyword).toBe('STER-PCR')
    expect(calls[1]![0].keyword).toBe('ENDO')
  })

  it('continues past a failed row and still fires onPromoted', async () => {
    vi.mocked(api.promoteAnalyses)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({} as never)
    const onPromoted = vi.fn()
    render(
      <BulkPromoteDialog
        analyses={[promotable, mk({ uid: 'mk1:821', review_state: 'to_be_verified', keyword: 'ENDO', result: '0.4' })]}
        open
        onOpenChange={() => {}}
        onPromoted={onPromoted}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^Promote 2/ }))
    await waitFor(() => expect(onPromoted).toHaveBeenCalled())
    expect(vi.mocked(api.promoteAnalyses)).toHaveBeenCalledTimes(2)
  })
})
