import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  canVarianceVerify,
  deriveBulkActions,
  isPromotable,
  ALLOWED_TRANSITIONS_TEST_EXPORT as ALLOWED_TRANSITIONS,
  StatusBadge,
  isVarianceMember,
  showVarianceChip,
  VarianceChip,
} from '@/components/senaite/AnalysisTable'
import type { SenaiteAnalysis } from '@/lib/api'

const mk = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis =>
  ({
    uid: 'mk1:900',
    keyword: 'PUR_GHKCU',
    title: 'GHK-Cu - Purity',
    result: '99',
    review_state: 'to_be_verified',
    promoted_to_parent_id: null,
    ...over,
  }) as SenaiteAnalysis

describe('canVarianceVerify (kind-based)', () => {
  it('true for an mk1 to_be_verified row whose vial kind is variance', () => {
    expect(canVarianceVerify(mk({}), 'variance')).toBe(true)
  })
  it('false when the vial kind is core, null, or undefined', () => {
    expect(canVarianceVerify(mk({}), 'core')).toBe(false)
    expect(canVarianceVerify(mk({}), null)).toBe(false)
    expect(canVarianceVerify(mk({}), undefined)).toBe(false)
  })
  it('false for SENAITE rows, wrong states, promoted rows regardless of kind', () => {
    expect(canVarianceVerify(mk({ uid: 'a8c27e69bfa8' }), 'variance')).toBe(false)
    expect(canVarianceVerify(mk({ review_state: 'unassigned' }), 'variance')).toBe(false)
    expect(canVarianceVerify(mk({ review_state: 'promoted' }), 'variance')).toBe(false)
    expect(canVarianceVerify(mk({ promoted_to_parent_id: 77 }), 'variance')).toBe(false)
  })
})

describe('isPromotable (kind-aware)', () => {
  it('false when the vial kind is variance', () => {
    expect(isPromotable(mk({}), 'variance')).toBe(false)
  })
  it('true for a core / kindless to_be_verified mk1 row', () => {
    expect(isPromotable(mk({}), 'core')).toBe(true)
    expect(isPromotable(mk({}), null)).toBe(true)
    expect(isPromotable(mk({}))).toBe(true)
  })
})

describe('variance_verified transitions table', () => {
  it('offers retest only', () => {
    expect(ALLOWED_TRANSITIONS['variance_verified']).toEqual(['retest'])
  })
})

describe('isVarianceMember (state-independent membership, kind-based)', () => {
  it('true for a variance-kind sub-row regardless of state', () => {
    expect(isVarianceMember(mk({ review_state: 'unassigned' }), 'variance')).toBe(true)
    expect(isVarianceMember(mk({ review_state: 'received' }), 'variance')).toBe(true)
    expect(isVarianceMember(mk({ review_state: 'to_be_verified' }), 'variance')).toBe(true)
    expect(isVarianceMember(mk({ review_state: 'variance_verified' }), 'variance')).toBe(true)
    expect(isVarianceMember(mk({ promoted_to_parent_id: 5 }), 'variance')).toBe(true)
  })
  it('false for SENAITE rows, core kind, null/undefined kind', () => {
    expect(isVarianceMember(mk({ uid: 'a8c27e69bfa8' }), 'variance')).toBe(false)
    expect(isVarianceMember(mk({}), 'core')).toBe(false)
    expect(isVarianceMember(mk({}), null)).toBe(false)
    expect(isVarianceMember(mk({}), undefined)).toBe(false)
  })
})

describe('showVarianceChip (member, with suppression)', () => {
  it('true for a variance-kind member in a pre-signoff state', () => {
    expect(showVarianceChip(mk({ review_state: 'unassigned' }), 'variance')).toBe(true)
    expect(showVarianceChip(mk({ review_state: 'to_be_verified' }), 'variance')).toBe(true)
  })
  it('suppressed on promoted rows — both by state and by parent-id', () => {
    // review_state 'promoted' with promoted_to_parent_id null is the retract-and-
    // repromote gap (service.py clears the id when the parent line is retracted);
    // the `|| review_state === 'promoted'` branch in showVarianceChip is load-
    // bearing for this case, NOT dead code — do not remove it.
    expect(showVarianceChip(mk({ review_state: 'promoted' }), 'variance')).toBe(false)
    expect(showVarianceChip(mk({ promoted_to_parent_id: 5 }), 'variance')).toBe(false)
  })
  it('suppressed on variance_verified (already badged Verified — Variance)', () => {
    expect(showVarianceChip(mk({ review_state: 'variance_verified' }), 'variance')).toBe(false)
  })
  it('false when not a member (core kind)', () => {
    expect(showVarianceChip(mk({}), 'core')).toBe(false)
  })
})

describe('VarianceChip', () => {
  it('renders the Variance label', () => {
    render(<VarianceChip />)
    expect(screen.getByText('Variance')).toBeInTheDocument()
  })
})

describe('deriveBulkActions — showVarianceVerify (kind-based)', () => {
  const v = (over: Partial<SenaiteAnalysis>) =>
    mk({ review_state: 'to_be_verified', promoted_to_parent_id: null, ...over })

  it('true when every selected row passes canVarianceVerify on a variance vial', () => {
    const sel = [v({ uid: 'mk1:1' }), v({ uid: 'mk1:2' })]
    expect(deriveBulkActions(sel, {}, 'variance').showVarianceVerify).toBe(true)
  })
  it('false if any selected row is not an mk1 native row', () => {
    const sel = [v({ uid: 'mk1:1' }), v({ uid: 'a8c27e69bfa8' })] // SENAITE row
    expect(deriveBulkActions(sel, {}, 'variance').showVarianceVerify).toBe(false)
  })
  it('false on a core / kindless vial', () => {
    const sel = [v({ uid: 'mk1:1' })]
    expect(deriveBulkActions(sel, {}, 'core').showVarianceVerify).toBe(false)
    expect(deriveBulkActions(sel, {}, null).showVarianceVerify).toBe(false)
    expect(deriveBulkActions(sel, {}).showVarianceVerify).toBe(false)
  })
  it('false on empty selection', () => {
    expect(deriveBulkActions([], {}, 'variance').showVarianceVerify).toBe(false)
  })
  it('false if any selected row is promoted (mutually exclusive with promote)', () => {
    const sel = [v({ uid: 'mk1:1' }), v({ uid: 'mk1:2', promoted_to_parent_id: 9 })]
    expect(deriveBulkActions(sel, {}, 'variance').showVarianceVerify).toBe(false)
  })
  it('suppresses bulk Promote on a variance vial', () => {
    const sel = [v({ uid: 'mk1:1' }), v({ uid: 'mk1:2' })]
    expect(deriveBulkActions(sel, {}, 'variance').showPromote).toBe(false)
    expect(deriveBulkActions(sel, {}, 'core').showPromote).toBe(true)
  })
})

describe('StatusBadge — variance', () => {
  it('renders Verified — Variance for the new state', () => {
    render(<StatusBadge state="variance_verified" />)
    expect(screen.getByText('Verified — Variance')).toBeInTheDocument()
  })
  it('varianceReady wins over promotable on to_be_verified', () => {
    render(<StatusBadge state="to_be_verified" promotable varianceReady />)
    expect(screen.getByText('Ready to Verify')).toBeInTheDocument()
    expect(screen.queryByText('Ready to Promote')).not.toBeInTheDocument()
  })
})
