import { describe, it, expect } from 'vitest'
import {
  assess,
  layoutPlates,
  nextSort,
  type PcrSample,
  type PcrSort,
} from '@/lib/pcr-plate'

// The samples list sorts by its columns and the plate is dealt in that order
// (Handler, 2026-09-24). Locked wells never move; ties keep worksheet order;
// blanks go last in both directions.

function s(id: string, extra: Partial<PcrSample> = {}): PcrSample {
  return {
    itemId: Number(id.replace(/\D/g, '')),
    id,
    order: '9001',
    identity: 'Examplerelin',
    received: null,
    priority: 'normal',
    assessment: assess(null, null, 'normal'),
    frozen: null,
    ...extra,
  }
}
const due = (d: string | null) => ({
  assessment: assess(d, '2026-09-01', 'normal'),
})
const dealt = (samples: PcrSample[], sort?: PcrSort) =>
  (layoutPlates(samples, { sort }).plates[0]?.placements ?? [])
    .filter(p => !p.isControl)
    .map(p => p.id)

describe('layoutPlates sort', () => {
  it('defaults to order number ascending, as before', () => {
    const samples = [
      s('P-3', { order: '7700' }),
      s('P-1', { order: '7600' }),
      s('P-2', { order: '7700' }),
    ]
    expect(dealt(samples)).toEqual(['P-1', 'P-3', 'P-2'])
    expect(dealt(samples, { key: 'order', dir: 'desc' })).toEqual([
      'P-3',
      'P-2',
      'P-1',
    ])
  })

  it('sorts sample ids naturally in both directions', () => {
    const samples = [s('P-1000'), s('P-999'), s('P-1001')]
    expect(dealt(samples, { key: 'sampleId', dir: 'asc' })).toEqual([
      'P-999',
      'P-1000',
      'P-1001',
    ])
    expect(dealt(samples, { key: 'sampleId', dir: 'desc' })).toEqual([
      'P-1001',
      'P-1000',
      'P-999',
    ])
  })

  it('puts blanks last whichever way the column is sorted', () => {
    const samples = [
      s('P-1', due(null)),
      s('P-2', due('2026-09-03')),
      s('P-3', due('2026-09-01')),
    ]
    expect(dealt(samples, { key: 'due', dir: 'asc' })).toEqual([
      'P-3',
      'P-2',
      'P-1',
    ])
    expect(dealt(samples, { key: 'due', dir: 'desc' })).toEqual([
      'P-2',
      'P-3',
      'P-1',
    ])
  })

  it('ranks priority expedited, high, then the rest, ties in worksheet order', () => {
    const samples = [
      s('P-1'),
      s('P-2', { priority: 'high' }),
      s('P-3', { priority: 'expedited' }),
      s('P-4', { priority: 'high' }),
    ]
    expect(dealt(samples, { key: 'priority', dir: 'asc' })).toEqual([
      'P-3',
      'P-2',
      'P-4',
      'P-1',
    ])
  })

  it('sorts by received date and by identity', () => {
    const samples = [
      s('P-1', { received: '2026-09-20', identity: 'Tirzepatide' }),
      s('P-2', { received: '2026-09-18', identity: 'BPC-157' }),
    ]
    expect(dealt(samples, { key: 'received', dir: 'asc' })).toEqual([
      'P-2',
      'P-1',
    ])
    expect(dealt(samples, { key: 'identity', dir: 'desc' })).toEqual([
      'P-1',
      'P-2',
    ])
  })

  it('worksheet order ignores the direction', () => {
    const samples = [s('P-2', { order: '7700' }), s('P-1', { order: '7600' })]
    expect(dealt(samples, { key: 'listed', dir: 'desc' })).toEqual([
      'P-2',
      'P-1',
    ])
  })

  it('never moves a locked well; only the loose samples are re-dealt', () => {
    const samples = [
      s('P-9', { frozen: { plate: 1, pos: 0 } }),
      s('P-2'),
      s('P-1'),
    ]
    const L = layoutPlates(samples, { sort: { key: 'sampleId', dir: 'desc' } })
    const at = (id: string) =>
      L.plates[0]?.placements.find(p => p.id === id)?.pos
    expect(at('P-9')).toBe(0)
    expect(dealt(samples, { key: 'sampleId', dir: 'asc' })).toEqual([
      'P-9',
      'P-1',
      'P-2',
    ])
  })
})

describe('nextSort', () => {
  it('a new column starts ascending and the same column flips', () => {
    expect(nextSort({ key: 'order', dir: 'asc' }, 'due')).toEqual({
      key: 'due',
      dir: 'asc',
    })
    expect(nextSort({ key: 'due', dir: 'asc' }, 'due')).toEqual({
      key: 'due',
      dir: 'desc',
    })
    expect(nextSort({ key: 'due', dir: 'desc' }, 'due')).toEqual({
      key: 'due',
      dir: 'asc',
    })
  })

  it('worksheet order has no direction', () => {
    expect(nextSort({ key: 'due', dir: 'desc' }, 'listed')).toEqual({
      key: 'listed',
      dir: 'asc',
    })
  })
})
