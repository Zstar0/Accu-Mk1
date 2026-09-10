import { describe, expect, it } from 'vitest'
import type { ReadyRow } from '@/lib/api'
import {
  groupByOrder,
  linesText,
  matchesQuery,
  reasonText,
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
