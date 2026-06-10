import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  canVarianceVerify,
  ALLOWED_TRANSITIONS_TEST_EXPORT as ALLOWED_TRANSITIONS,
  StatusBadge,
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

const ENTITLED = { hplcpurity_identity: 3 }

describe('canVarianceVerify', () => {
  it('true for an mk1 to_be_verified row on an entitled hplc vial', () => {
    expect(canVarianceVerify(mk({}), 'hplc', ENTITLED)).toBe(true)
  })
  it('false without entitlement for the role', () => {
    expect(canVarianceVerify(mk({}), 'hplc', {})).toBe(false)
    expect(canVarianceVerify(mk({}), 'hplc', undefined)).toBe(false)
  })
  it('false for endo role when only hplc variance purchased', () => {
    expect(canVarianceVerify(mk({}), 'endo', ENTITLED)).toBe(false)
  })
  it('true for endo role with endotoxin entitlement', () => {
    expect(canVarianceVerify(mk({}), 'endo', { endotoxin: 2 })).toBe(true)
  })
  it('false for SENAITE rows, wrong states, promoted rows, null role', () => {
    expect(canVarianceVerify(mk({ uid: 'a8c27e69bfa8' }), 'hplc', ENTITLED)).toBe(false)
    expect(canVarianceVerify(mk({ review_state: 'unassigned' }), 'hplc', ENTITLED)).toBe(false)
    expect(canVarianceVerify(mk({ review_state: 'promoted' }), 'hplc', ENTITLED)).toBe(false)
    expect(canVarianceVerify(mk({ promoted_to_parent_id: 77 }), 'hplc', ENTITLED)).toBe(false)
    expect(canVarianceVerify(mk({}), null, ENTITLED)).toBe(false)
  })
})

describe('variance_verified transitions table', () => {
  it('offers retest only', () => {
    expect(ALLOWED_TRANSITIONS['variance_verified']).toEqual(['retest'])
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
