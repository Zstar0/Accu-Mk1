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

  // Multi-tier follow-on — source line distinguishes per-group vs global
  // priority overrides and surfaces the group name when present.
  it('renders priorityGroup line when priorityScope=group and groupName provided', () => {
    const reason: SampleSlaReason = {
      tierSource: 'priority',
      priorityUsed: 'expedited',
      priorityScope: 'group',
      unmappedKeywords: [],
    }
    render(
      <SlaBreakdownTooltip
        tier={tier}
        status={status}
        reason={reason}
        priority="expedited"
        groupName="HPLC"
      />
    )
    const el = screen.getByTestId('sla-breakdown-tooltip')
    // i18n fallback: either the rendered English contains both interpolations
    // ("HPLC only") or the raw key matches.
    expect(el.textContent ?? '').toMatch(/HPLC|priorityGroup/i)
    expect(el.textContent ?? '').toMatch(/expedited/i)
  })

  it('renders priorityGlobal line when priorityScope=global', () => {
    const reason: SampleSlaReason = {
      tierSource: 'priority',
      priorityUsed: 'expedited',
      priorityScope: 'global',
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
    // "all groups" hint or the raw key.
    expect(el.textContent ?? '').toMatch(/all groups|priorityGlobal/i)
  })

  it('falls back to legacy priority line when priorityScope is undefined (single-tier callers)', () => {
    const reason: SampleSlaReason = {
      tierSource: 'priority',
      priorityUsed: 'expedited',
      // priorityScope intentionally omitted to mimic the legacy
      // resolveSampleTierWithReason output.
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
    // No "all groups" / "only" qualifier when the resolver didn't set a scope.
    const text = el.textContent ?? ''
    expect(text).toMatch(/expedited|source\.priority/i)
    expect(text).not.toMatch(/all groups/i)
    expect(text).not.toMatch(/only/i)
  })

  it('renders groupNamed line when tierSource=group and groupName provided', () => {
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
        groupName="Sterility"
      />
    )
    const el = screen.getByTestId('sla-breakdown-tooltip')
    // Group name should appear in the source line.
    expect(el.textContent ?? '').toMatch(/Sterility|groupNamed/i)
  })

  // Received date/time — first field (SLA clock start). Shared across all
  // surfaces that host the tooltip.
  it('renders "Received" as the first field when receivedAt provided', () => {
    const reason: SampleSlaReason = {
      tierSource: 'default',
      unmappedKeywords: [],
    }
    render(
      <SlaBreakdownTooltip
        tier={tier}
        status={status}
        reason={reason}
        priority="normal"
        receivedAt="2026-01-15T09:30:00"
      />
    )
    const el = screen.getByTestId('sla-breakdown-tooltip')
    const text = el.textContent ?? ''
    // formatDate (en-US, no year) renders the month/day — stable regardless of
    // timezone because the timestamp has no 'Z' (parsed as local).
    expect(text).toMatch(/Jan 15/)
    // First field: the received date appears before the tier name "Standard".
    expect(text.indexOf('Jan 15')).toBeLessThan(text.indexOf('Standard'))
  })

  it('renders "Received" first in published (historical) mode too', () => {
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
        receivedAt="2026-01-15T09:30:00"
        isPublished
      />
    )
    const el = screen.getByTestId('sla-breakdown-tooltip')
    const text = el.textContent ?? ''
    expect(text).toMatch(/Jan 15/)
    expect(text.indexOf('Jan 15')).toBeLessThan(text.indexOf('Standard'))
  })

  it('omits the Received line when receivedAt is null or undefined', () => {
    const reason: SampleSlaReason = {
      tierSource: 'default',
      unmappedKeywords: [],
    }
    render(
      <SlaBreakdownTooltip
        tier={tier}
        status={status}
        reason={reason}
        priority="normal"
        receivedAt={null}
      />
    )
    const el = screen.getByTestId('sla-breakdown-tooltip')
    expect(el.textContent ?? '').not.toMatch(/received/i)
  })

  it('per-group priority line requires groupName — falls back to global when groupName absent', () => {
    // Defensive: priorityScope='group' but no groupName supplied (caller bug
    // or NO_GROUP_KEY snapshot). Tooltip should NOT render a malformed
    // "{{group}} only" with an empty interpolation.
    const reason: SampleSlaReason = {
      tierSource: 'priority',
      priorityUsed: 'expedited',
      priorityScope: 'group',
      unmappedKeywords: [],
    }
    render(
      <SlaBreakdownTooltip
        tier={tier}
        status={status}
        reason={reason}
        priority="expedited"
        // groupName omitted
      />
    )
    const el = screen.getByTestId('sla-breakdown-tooltip')
    // Falls back to global line (or the legacy line) — never the malformed
    // priorityGroup variant with an empty {{group}}.
    expect(el.textContent ?? '').not.toMatch(/\(expedited, \s* only\)/i)
  })
})
