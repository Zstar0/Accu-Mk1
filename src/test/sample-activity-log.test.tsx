import { describe, it, expect } from 'vitest'
import { eventLevelFor, eventIcon } from '@/components/senaite/SampleActivityLog'

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
})
