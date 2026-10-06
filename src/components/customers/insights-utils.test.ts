import { describe, expect, it } from 'vitest'
import {
  cohortTint,
  fmtDelta,
  fmtMoney,
  fmtPct,
  fmtPoints,
  normOrderNumber,
} from './insights-utils'

describe('insights utils', () => {
  it('formats money strings without float drift', () => {
    expect(fmtMoney('1070000.00')).toBe('$1.07M')
    expect(fmtMoney('84210.4')).toBe('$84,210')
    expect(fmtMoney('566.00')).toBe('$566')
    expect(fmtMoney('0.00')).toBe('$0')
  })
  it('formats shares and deltas', () => {
    expect(fmtPct(0.24)).toBe('24.0%')
    expect(fmtPct(null)).toBe('n/a')
    expect(fmtDelta(-0.71)).toEqual({ text: '▼ 71%', tone: 'down' })
    expect(fmtDelta(0.02)).toEqual({ text: '▲ 2%', tone: 'flat' })
    expect(fmtDelta(null)).toEqual({ text: 'n/a', tone: 'flat' })
  })
  it('formats rate changes in points', () => {
    expect(fmtPoints(0.24, 0.271)).toEqual({ text: '▼ 3.1 pts', tone: 'down' })
    expect(fmtPoints(0.28, 0.271)).toEqual({ text: '▲ 0.9 pts', tone: 'flat' })
    expect(fmtPoints(0.3, null)).toEqual({ text: 'n/a', tone: 'flat' })
  })
  it('tints cohort cells and flags low returns', () => {
    expect(cohortTint(null)).toBe('')
    expect(cohortTint(0.13)).toContain('red')
    expect(cohortTint(0.39)).toContain('emerald')
  })
})

describe('normOrderNumber', () => {
  it('drops WP- / # prefixes and whitespace', () => {
    for (const raw of ['WP-8642', 'wp-8642', '#8642', ' 8642 ', 8642])
      expect(normOrderNumber(raw)).toBe('8642')
  })
})
