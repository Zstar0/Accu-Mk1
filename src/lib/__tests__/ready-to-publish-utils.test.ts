import { describe, expect, it } from 'vitest'
import type { ReadyRow } from '@/lib/api'
import {
  groupByOrder,
  linesText,
  matchesQuery,
  reasonText,
  sortRows,
  splitHeld,
  worstColor,
} from '@/components/reports/ready-to-publish-utils'

function row(over: Partial<ReadyRow> & { sample_id: string }): ReadyRow {
  return {
    status: 'verified',
    client: 'Acme',
    order: '7001',
    email: 'a@acme.test',
    created_at: '2026-09-01T12:00:00',
    received_at: '2026-09-02T12:00:00',
    lot: 'L1',
    analytes: ['BPC-157'],
    reasons: ['all_verified'],
    flags: [],
    lines: { total: 1, verified: 1, pending: [] },
    priority: 'normal',
    sla: null,
    hold: null,
    ...over,
  }
}

function sla(color: 'red' | 'amber' | 'green', breached = color === 'red') {
  return {
    tier: 'Standard',
    target_minutes: 1440,
    elapsed_minutes: 100,
    remaining_minutes: 1340,
    breached,
    color,
  }
}

describe('groupByOrder', () => {
  it('keeps server order across groups (first appearance) and within a group', () => {
    const rows = [
      row({ sample_id: 'P-3', order: '7002', sla: sla('red') }),
      row({ sample_id: 'P-1', order: '7001', sla: sla('amber') }),
      row({ sample_id: 'P-4', order: '7002', sla: sla('green') }),
      row({ sample_id: 'P-2', order: '7001' }),
    ]
    const groups = groupByOrder(rows)
    expect(groups.map(g => g.order)).toEqual(['7002', '7001'])
    expect(groups[0]?.rows.map(r => r.sample_id)).toEqual(['P-3', 'P-4'])
    expect(groups[1]?.rows.map(r => r.sample_id)).toEqual(['P-1', 'P-2'])
  })

  it('carries worst colour and breached count per group', () => {
    const groups = groupByOrder([
      row({ sample_id: 'P-1', sla: sla('green') }),
      row({ sample_id: 'P-2', sla: sla('red') }),
      row({ sample_id: 'P-3' }),
    ])
    expect(groups[0]?.worst).toBe('red')
    expect(groups[0]?.breached).toBe(1)
  })

  it('buckets rows without an order number under a dash', () => {
    const groups = groupByOrder([row({ sample_id: 'P-1', order: '' })])
    expect(groups[0]?.order).toBe('—')
  })

  it('fills client/email from the first row that has them', () => {
    const groups = groupByOrder([
      row({ sample_id: 'P-1', client: null, email: null }),
      row({ sample_id: 'P-2', client: 'Beta', email: 'b@beta.test' }),
    ])
    expect(groups[0]?.client).toBe('Beta')
    expect(groups[0]?.email).toBe('b@beta.test')
  })
})

describe('worstColor', () => {
  it('ranks red over amber over green and ignores rows without SLA', () => {
    expect(worstColor([row({ sample_id: 'a' })])).toBeNull()
    expect(
      worstColor([
        row({ sample_id: 'a', sla: sla('green') }),
        row({ sample_id: 'b', sla: sla('amber') }),
      ])
    ).toBe('amber')
  })
})

describe('text helpers', () => {
  it('reasonText joins in backend order', () => {
    expect(reasonText(['all_verified', 'flag_ready'])).toBe(
      'All lines verified · Flag: Ready for Publish'
    )
  })

  it('linesText lists pending keywords', () => {
    expect(linesText({ total: 3, verified: 2, pending: ['STER-PCR'] })).toBe(
      '2/3 verified · pending: STER-PCR'
    )
    expect(linesText({ total: 1, verified: 1, pending: [] })).toBe(
      '1/1 verified'
    )
  })

  it('matchesQuery searches order, sample, client, email, lot and analytes', () => {
    const r = row({ sample_id: 'P-1986', analytes: ['Somatropin'] })
    expect(matchesQuery(r, '')).toBe(true)
    expect(matchesQuery(r, 'somat')).toBe(true)
    expect(matchesQuery(r, '1986')).toBe(true)
    expect(matchesQuery(r, 'acme.test')).toBe(true)
    expect(matchesQuery(r, 'nope')).toBe(false)
  })
})

describe('splitHeld', () => {
  it('parks rows with an open hold and keeps order in both halves', () => {
    const hold = {
      flag_id: 1,
      type: 'new_type_7',
      label: 'On Hold',
      color: '#64748b',
      status: 'open',
      title: 'Customer paying',
      since: '2026-09-09T12:00:00',
    }
    const { live, held } = splitHeld([
      row({ sample_id: 'P-1' }),
      row({ sample_id: 'P-2', hold }),
      row({ sample_id: 'P-3' }),
      row({ sample_id: 'P-4', hold }),
    ])
    expect(live.map(r => r.sample_id)).toEqual(['P-1', 'P-3'])
    expect(held.map(r => r.sample_id)).toEqual(['P-2', 'P-4'])
  })
})

describe('sortRows', () => {
  const a = row({
    sample_id: 'P-1',
    order: '7002',
    received_at: '2026-09-03T00:00:00',
    lines: { total: 4, verified: 3, pending: ['X'] },
    reasons: ['flag_partial'],
    sla: {
      tier: 'Std',
      target_minutes: 100,
      elapsed_minutes: 150,
      remaining_minutes: -50,
      breached: true,
      color: 'red',
    },
  })
  const b = row({
    sample_id: 'P-2',
    order: '7001',
    received_at: '2026-09-01T00:00:00',
    lines: { total: 2, verified: 2, pending: [] },
    reasons: ['all_verified'],
    sla: {
      tier: 'Std',
      target_minutes: 100,
      elapsed_minutes: 20,
      remaining_minutes: 80,
      breached: false,
      color: 'green',
    },
  })
  const c = row({
    sample_id: 'P-3',
    order: '7003',
    received_at: null,
    lines: { total: 3, verified: 3, pending: [] },
    reasons: ['flag_ready'],
    sla: null,
  })
  const ids = (rows: ReadyRow[]) => rows.map(r => r.sample_id)

  it('null sort keeps the backend order', () => {
    expect(ids(sortRows([a, b, c], null))).toEqual(['P-1', 'P-2', 'P-3'])
  })
  it('sorts by received with nulls last in both directions', () => {
    expect(ids(sortRows([a, b, c], { key: 'received', dir: 'asc' }))).toEqual([
      'P-2',
      'P-1',
      'P-3',
    ])
    expect(ids(sortRows([a, b, c], { key: 'received', dir: 'desc' }))).toEqual([
      'P-1',
      'P-2',
      'P-3',
    ])
  })
  it('sorts SLA by time remaining, breached first ascending, missing SLA last', () => {
    expect(ids(sortRows([a, b, c], { key: 'sla', dir: 'asc' }))).toEqual([
      'P-1',
      'P-2',
      'P-3',
    ])
  })
  it('sorts status by fraction verified and sample by order then id', () => {
    expect(ids(sortRows([a, b, c], { key: 'status', dir: 'asc' }))[0]).toBe(
      'P-1'
    )
    expect(ids(sortRows([a, b, c], { key: 'sample', dir: 'asc' }))).toEqual([
      'P-2',
      'P-1',
      'P-3',
    ])
  })
  it('sorts why by reason rank and is stable on ties', () => {
    expect(ids(sortRows([a, b, c], { key: 'why', dir: 'asc' }))).toEqual([
      'P-2',
      'P-3',
      'P-1',
    ])
    const t1 = row({ sample_id: 'T-1', analytes: ['X'] })
    const t2 = row({ sample_id: 'T-2', analytes: ['X'] })
    expect(ids(sortRows([t1, t2], { key: 'analytes', dir: 'desc' }))).toEqual([
      'T-1',
      'T-2',
    ])
  })
})
