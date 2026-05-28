import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SlaBreakdownTooltip } from '@/components/explorer/SlaBreakdownTooltip'
import type { SlaTier, SlaStatus } from '@/lib/api'
import type { SampleSlaReason } from '@/lib/sla-resolution'

const tier: SlaTier = {
  id: 1,
  name: 'Standard',
  target_minutes: 1440,
  business_hours_only: false,
  is_default: true,
  amber_threshold_percent: 20,
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-01-01T00:00:00',
}

const status: SlaStatus = {
  target_minutes: 1440,
  elapsed_minutes: 720,
  remaining_minutes: 720,
  breached: false,
}

describe('SlaBreakdownTooltip', () => {
  it('renders priority-source line for tierSource priority', () => {
    const reason: SampleSlaReason = {
      tierSource: 'priority',
      priorityUsed: 'expedited',
      unmappedKeywords: [],
    }
    render(
      <SlaBreakdownTooltip
        tier={tier}
        status={status}
        reason={reason}
        priority="expedited"
      />
    )
    const el = screen.getByTestId('sla-breakdown-tooltip')
    expect(el.getAttribute('data-tier-source')).toBe('priority')
    // i18n fallback: key text contains 'priority' or 'expedited' interpolation.
    expect(el.textContent ?? '').toMatch(/priority|expedited|source\.priority/i)
  })

  it('renders group-source line for tierSource group (single candidate)', () => {
    const reason: SampleSlaReason = {
      tierSource: 'group',
      unmappedKeywords: [],
    }
    render(
      <SlaBreakdownTooltip
        tier={tier}
        status={status}
        reason={reason}
        priority="normal"
      />
    )
    const el = screen.getByTestId('sla-breakdown-tooltip')
    expect(el.getAttribute('data-tier-source')).toBe('group')
    // No "Tightest of N candidates" line for single-candidate case.
    expect(el.textContent ?? '').not.toMatch(/groupMultiple/i)
  })

  it('renders multi-group "tightest of N" when multiple candidates', () => {
    const reason: SampleSlaReason = {
      tierSource: 'group',
      unmappedKeywords: [],
      multiGroupCandidates: [
        { tierName: 'Tight', targetMinutes: 60 },
        { tierName: 'Loose', targetMinutes: 480 },
        { tierName: 'Medium', targetMinutes: 240 },
      ],
    }
    render(
      <SlaBreakdownTooltip
        tier={tier}
        status={status}
        reason={reason}
        priority="normal"
      />
    )
    const el = screen.getByTestId('sla-breakdown-tooltip')
    // count=3 interpolated into the i18n key.
    expect(el.textContent ?? '').toMatch(/3|groupMultiple/i)
  })

  it('renders default-source line for tierSource default and unmapped footer when present', () => {
    const reason: SampleSlaReason = {
      tierSource: 'default',
      unmappedKeywords: ['HPLC-X', 'HPLC-Y'],
    }
    render(
      <SlaBreakdownTooltip
        tier={tier}
        status={status}
        reason={reason}
        priority="normal"
      />
    )
    const el = screen.getByTestId('sla-breakdown-tooltip')
    expect(el.getAttribute('data-tier-source')).toBe('default')
    // Unmapped footer shows the keyword list.
    expect(el.textContent ?? '').toMatch(/HPLC-X|HPLC-Y|unmapped/i)
  })

  it('renders no-tier-configured line for tierSource none', () => {
    const reason: SampleSlaReason = {
      tierSource: 'none',
      unmappedKeywords: [],
    }
    render(
      <SlaBreakdownTooltip
        tier={tier}
        status={status}
        reason={reason}
        priority="normal"
      />
    )
    const el = screen.getByTestId('sla-breakdown-tooltip')
    expect(el.getAttribute('data-tier-source')).toBe('none')
    expect(el.textContent ?? '').toMatch(/none|no tier|source\.none/i)
  })

  it('renders driving sample line when drivingSampleId provided', () => {
    const reason: SampleSlaReason = {
      tierSource: 'group',
      unmappedKeywords: [],
    }
    render(
      <SlaBreakdownTooltip
        tier={tier}
        status={status}
        reason={reason}
        drivingSampleId="PB-0056"
      />
    )
    expect(screen.getByText(/PB-0056/)).toBeInTheDocument()
  })

  it('renders "Met" header when isPublished + not breached', () => {
    const reason: SampleSlaReason = {
      tierSource: 'group',
      unmappedKeywords: [],
    }
    const publishedStatus: SlaStatus = {
      target_minutes: 1440,
      elapsed_minutes: 1200,
      remaining_minutes: 240,
      breached: false,
    }
    render(
      <SlaBreakdownTooltip
        tier={tier}
        status={publishedStatus}
        reason={reason}
        priority="normal"
        isPublished
      />
    )
    const el = screen.getByTestId('sla-breakdown-tooltip')
    // i18n fallback returns the key text when no instance is configured, so
    // either the rendered English "Met" or the raw "publishedMet" matches.
    expect(el.textContent ?? '').toMatch(/met|publishedMet/i)
  })

  it('renders "Missed by Xh" header when isPublished + breached', () => {
    const reason: SampleSlaReason = {
      tierSource: 'group',
      unmappedKeywords: [],
    }
    const breachedStatus: SlaStatus = {
      target_minutes: 1440,
      elapsed_minutes: 1920,
      remaining_minutes: -480,
      breached: true,
    }
    render(
      <SlaBreakdownTooltip
        tier={tier}
        status={breachedStatus}
        reason={reason}
        priority="normal"
        isPublished
      />
    )
    const el = screen.getByTestId('sla-breakdown-tooltip')
    expect(el.textContent ?? '').toMatch(/missed|publishedMissed/i)
  })

  it('renders "Total time:" instead of "Elapsed:" when isPublished', () => {
    const reason: SampleSlaReason = {
      tierSource: 'group',
      unmappedKeywords: [],
    }
    render(
      <SlaBreakdownTooltip
        tier={tier}
        status={status}
        reason={reason}
        priority="normal"
        isPublished
      />
    )
    const el = screen.getByTestId('sla-breakdown-tooltip')
    expect(el.textContent ?? '').toMatch(/total time|totalTime/i)
  })
})
