import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PromotedFromBadge } from '@/components/senaite/PromotedFromBadge'
import type { ParentPromotionInfo } from '@/lib/api'

describe('PromotedFromBadge', () => {
  it('renders null when promotion is undefined', () => {
    const { container } = render(<PromotedFromBadge promotion={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders source label with sample_id', () => {
    const promotion: ParentPromotionInfo = {
      keyword: 'BPC-PURITY',
      parent_analysis_id: 42,
      result_value: '98.5',
      promoted_at: '2026-06-05T12:00:00Z',
      promoted_by_email: 'lab@accumarklabs.com',
      sources: [{ sample_id: 'P-0143-S01', contribution_kind: 'chosen' }],
    }
    const { getByLabelText, getByText } = render(<PromotedFromBadge promotion={promotion} />)
    // text content
    expect(getByText(/from P-0143-S01/)).toBeTruthy()
    // aria-label
    expect(getByLabelText('Promoted from sub-sample')).toBeTruthy()
  })

  it('renders tooltip with email and date', () => {
    const promotion: ParentPromotionInfo = {
      keyword: 'BPC-PURITY',
      parent_analysis_id: 42,
      result_value: '98.5',
      promoted_at: '2026-06-05T12:00:00Z',
      promoted_by_email: 'lab@accumarklabs.com',
      sources: [{ sample_id: 'P-0143-S01', contribution_kind: 'chosen' }],
    }
    const { container } = render(<PromotedFromBadge promotion={promotion} />)
    const span = container.querySelector('[title]')
    expect(span).toBeTruthy()
    expect(span!.getAttribute('title')).toContain('lab@accumarklabs.com')
    expect(span!.getAttribute('title')).toContain('2026-06-05')
  })

  it('joins multiple sources with comma', () => {
    const promotion: ParentPromotionInfo = {
      keyword: 'BPC-PURITY',
      parent_analysis_id: 42,
      result_value: '98.5',
      promoted_at: '2026-06-05T12:00:00Z',
      promoted_by_email: null,
      sources: [
        { sample_id: 'P-0143-S01', contribution_kind: 'chosen' },
        { sample_id: 'P-0143-S02', contribution_kind: 'checked' },
      ],
    }
    const { getByText } = render(<PromotedFromBadge promotion={promotion} />)
    expect(getByText(/from P-0143-S01, P-0143-S02/)).toBeTruthy()
  })

  it('falls back to "sub-sample" for null sample_ids', () => {
    const promotion: ParentPromotionInfo = {
      keyword: 'BPC-PURITY',
      parent_analysis_id: 42,
      result_value: null,
      promoted_at: '2026-06-05T12:00:00Z',
      promoted_by_email: null,
      sources: [{ sample_id: null, contribution_kind: 'chosen' }],
    }
    const { getByText } = render(<PromotedFromBadge promotion={promotion} />)
    expect(getByText(/from sub-sample/)).toBeTruthy()
  })
})
