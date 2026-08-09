import { describe, it, expect } from 'vitest'
import { eventLevelFor, eventIcon } from '@/components/senaite/SampleActivityLog'
import type { SampleActivityEvent } from '@/lib/api'

describe('SampleActivityLog', () => {
  it('move out of variance is warn', () => {
    expect(eventLevelFor({ event: 'role_assigned',
      details: { kind_from: 'variance', kind_to: null } } as any)).toBe('warn')
  })

  it('other role_assigned stays accent', () => {
    expect(eventLevelFor({ event: 'role_assigned',
      details: { kind_from: null, kind_to: 'variance' } } as any)).toBe('accent')
  })

  // Task 9 R1: the three native parent-verification events (Task 7 backend)
  // had no case in eventToLevel/eventIcon and rendered as a dim default dot
  // with the raw event name. verified -> positive/check-style (matches
  // coa_published/prep_completed); retested/un-promote -> warning/rotate-
  // style (matches retest_created's rotate glyph, retested_as's warn level).
  it.each([
    ['parent_analysis_verified', 'success'],
    ['parent_analysis_retested', 'warn'],
    ['promoted_source_retested', 'warn'],
  ] as const)('%s is %s', (event, level) => {
    expect(eventLevelFor({ event, details: {} } as any)).toBe(level)
  })

  it.each([
    ['parent_analysis_verified', '✔'],
    ['parent_analysis_retested', '↻'],
    ['promoted_source_retested', '↻'],
  ] as const)('%s icon is %s', (event, icon) => {
    expect(eventIcon(event)).toBe(icon)
  })

  // Task 6 (analysis-amendment-audit): the two new activity-log event types
  // from Task 5's before/after capture. result_entered is a routine info-level
  // event; analysis_amended must be visually loud (warn) — that's the ISO
  // point of this slice, since amendments to a submitted result need to stand
  // out from ordinary result entry.
  it('renders a result_entered event with its label', () => {
    const event: SampleActivityEvent = {
      timestamp: '2026-08-08T12:00:00',
      event: 'result_entered',
      label: 'Result entered — Sterility USP<71>: Not Detected (P-0145-S02)',
      details: {},
      source: 'lims_analysis_transitions',
    }
    expect(event.label).toBe('Result entered — Sterility USP<71>: Not Detected (P-0145-S02)')
    expect(eventLevelFor(event)).toBe('info')
    expect(eventIcon(event.event)).toBe('■')
  })

  it('renders an analysis_amended event with warn styling', () => {
    const event: SampleActivityEvent = {
      timestamp: '2026-08-08T12:05:00',
      event: 'analysis_amended',
      label: 'Result corrected — Sterility USP<71>: 0.92 → 0.95 (P-0145-S02)',
      details: {},
      source: 'lims_analysis_transitions',
    }
    expect(event.label).toBe('Result corrected — Sterility USP<71>: 0.92 → 0.95 (P-0145-S02)')
    expect(eventLevelFor(event)).toBe('warn')
    expect(eventIcon(event.event)).toBe('✎')
  })
})
