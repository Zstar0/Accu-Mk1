import { describe, it, expect } from 'vitest'
import { sortPreps, type PrepSortRow } from '@/lib/sample-prep-sort'
import { initialLastName } from '@/lib/user-display'

const row = (over: Partial<PrepSortRow> & { id: number }): PrepSortRow => ({
  sampleId: null,
  peptide: null,
  declaredWt: null,
  targetConc: null,
  actualConc: null,
  slaRemaining: null,
  statusRank: 0,
  createdAt: '2026-09-01T00:00:00',
  createdBy: '',
  ...over,
})
const ids = (rows: PrepSortRow[]) => rows.map(r => r.id)

describe('sortPreps', () => {
  it('SLA ascending puts the most overdue first, then the least time left', () => {
    const rows = [
      row({ id: 1, slaRemaining: 600 }),
      row({ id: 2, slaRemaining: -1152 }), // 2d 3h over
      row({ id: 3, slaRemaining: 288 }),
      row({ id: 4, slaRemaining: -30 }),
    ]
    expect(ids(sortPreps(rows, 'sla', 'asc'))).toEqual([2, 4, 3, 1])
    expect(ids(sortPreps(rows, 'sla', 'desc'))).toEqual([1, 3, 4, 2])
  })

  it('rows with no SLA clock (standards, not yet received) sort last in BOTH directions', () => {
    const rows = [
      row({ id: 1, slaRemaining: null }),
      row({ id: 2, slaRemaining: 100 }),
      row({ id: 3, slaRemaining: -5 }),
    ]
    expect(ids(sortPreps(rows, 'sla', 'asc'))).toEqual([3, 2, 1])
    expect(ids(sortPreps(rows, 'sla', 'desc'))).toEqual([2, 3, 1])
  })

  it('ties keep the incoming (newest-first) order', () => {
    const rows = [
      row({ id: 1, slaRemaining: 100 }),
      row({ id: 2, slaRemaining: 100 }),
      row({ id: 3, slaRemaining: null }),
      row({ id: 4, slaRemaining: null }),
    ]
    expect(ids(sortPreps(rows, 'sla', 'asc'))).toEqual([1, 2, 3, 4])
  })

  it('sorts sample ids naturally, so P-999 comes before P-1000', () => {
    const rows = [
      row({ id: 1, sampleId: 'P-1000' }),
      row({ id: 2, sampleId: 'P-999' }),
      row({ id: 3, sampleId: null }),
      row({ id: 4, sampleId: 'PB-0042' }),
    ]
    expect(ids(sortPreps(rows, 'sampleId', 'asc'))).toEqual([2, 1, 4, 3])
  })

  it('sorts text case-insensitively and numbers numerically', () => {
    const text = [
      row({ id: 1, peptide: 'bpc-157' }),
      row({ id: 2, peptide: 'AOD' }),
      row({ id: 3, peptide: 'Tirz' }),
    ]
    expect(ids(sortPreps(text, 'peptide', 'asc'))).toEqual([2, 1, 3])
    const nums = [
      row({ id: 1, actualConc: 349.91 }),
      row({ id: 2, actualConc: 203.59 }),
      row({ id: 3, actualConc: null }),
    ]
    expect(ids(sortPreps(nums, 'actualConc', 'desc'))).toEqual([1, 2, 3])
  })

  it('sorts status by workflow order and created by date', () => {
    const rows = [
      row({ id: 1, statusRank: 4, createdAt: '2026-09-03T00:00:00' }),
      row({ id: 2, statusRank: 0, createdAt: '2026-09-01T00:00:00' }),
      row({ id: 3, statusRank: 2, createdAt: '2026-09-02T00:00:00' }),
    ]
    expect(ids(sortPreps(rows, 'status', 'asc'))).toEqual([2, 3, 1])
    expect(ids(sortPreps(rows, 'createdAt', 'desc'))).toEqual([1, 3, 2])
  })

  it('does not mutate its input', () => {
    const rows = [
      row({ id: 1, slaRemaining: 5 }),
      row({ id: 2, slaRemaining: 1 }),
    ]
    sortPreps(rows, 'sla', 'asc')
    expect(ids(rows)).toEqual([1, 2])
  })
})

describe('initialLastName', () => {
  it('renders "F. Lastname" when both names are set', () => {
    expect(
      initialLastName({
        first_name: 'forrest',
        last_name: 'Parker',
        email: 'f@x.com',
      })
    ).toBe('F. Parker')
  })

  it('falls back to the single name, then the email local part', () => {
    expect(
      initialLastName({ first_name: 'Dennis', last_name: '', email: 'd@x.com' })
    ).toBe('Dennis')
    expect(
      initialLastName({
        first_name: null,
        last_name: 'Parker',
        email: 'p@x.com',
      })
    ).toBe('Parker')
    expect(initialLastName({ email: 'lab.tech@accumark.com' })).toBe('lab.tech')
  })
})
