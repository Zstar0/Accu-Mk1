import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
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
    // sample id renders as a link to the sub-sample page
    const link = getByText('P-0143-S01') as HTMLAnchorElement
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/#senaite/sample-details?id=P-0143-S01')
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
    const { getByText, getByLabelText } = render(<PromotedFromBadge promotion={promotion} />)
    // each source is its own link; the joined text still reads "from a, b"
    expect((getByText('P-0143-S01') as HTMLAnchorElement).getAttribute('href'))
      .toBe('/#senaite/sample-details?id=P-0143-S01')
    expect((getByText('P-0143-S02') as HTMLAnchorElement).getAttribute('href'))
      .toBe('/#senaite/sample-details?id=P-0143-S02')
    expect(getByLabelText('Promoted from sub-sample').textContent)
      .toContain('from P-0143-S01, P-0143-S02')
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

  const base = { keyword: 'ARSENIC-PPM', parent_analysis_id: 1, promoted_at: '2026-09-26T03:13:56', promoted_by_email: 'josh@x' }

  it('renders the classic "from" link for a chosen promotion', () => {
    render(<PromotedFromBadge promotion={{ ...base, sources: [{ sample_id: 'P-1-S01', contribution_kind: 'chosen' }] }} />)
    expect(screen.getByText(/^from/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'P-1-S01' })).toHaveAttribute('href', '/#senaite/sample-details?id=P-1-S01')
    expect(screen.queryByText(/carried/i)).not.toBeInTheDocument()
  })

  it('renders "Carried from <vial>" for a carried promotion, linking the original vial', () => {
    render(<PromotedFromBadge promotion={{ ...base, sources: [{ sample_id: 'P-9001-S02', contribution_kind: 'carried', parent_sample_id: 'P-9001' }] }} />)
    expect(screen.getByText(/carried from/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'P-9001-S02' })).toHaveAttribute('href', '/#senaite/sample-details?id=P-9001-S02')
    expect(screen.getByLabelText(/carried from original/i)).toHaveAttribute('title', expect.stringMatching(/Carried from P-9001/))
  })

  it('falls back to the parent sample when the carried source has no vial', () => {
    render(<PromotedFromBadge promotion={{ ...base, sources: [{ sample_id: null, contribution_kind: 'carried', parent_sample_id: 'P-9001' }] }} />)
    expect(screen.getByRole('link', { name: 'P-9001' })).toHaveAttribute('href', '/#senaite/sample-details?id=P-9001')
  })
})
