// Known numbers from September_2026_Endotoxin.xlsx and the LAL SOP, carried over
// from tools-dennis/tools/endotoxin-log/calc.test.js. If these still pass, the
// maths survived the port. Due dates are the SLA engine's (test_sla_deadline.py).
import { describe, it, expect } from 'vitest'
import {
  autoVolumeMl,
  calcEndoPrep,
  isBacWater,
  labDate,
  orderForBench,
  fmtUl,
  fmt,
  type LabCalendar,
} from '@/lib/endo-prep'

const cal: LabCalendar = {
  timezone: 'America/Los_Angeles',
  workingDays: [0, 1, 2, 3, 4],
  holidays: new Map([['2026-09-07', 'Labor Day']]),
}

describe('endo-prep: reconstitution volume', () => {
  it('is 1 mL plus 1 per whole 50 mg, capped at 10', () => {
    expect(autoVolumeMl(10)).toBe(1)
    expect(autoVolumeMl(49)).toBe(1)
    expect(autoVolumeMl(50)).toBe(2)
    expect(autoVolumeMl(120)).toBe(3)
    expect(autoVolumeMl(449)).toBe(9)
    expect(autoVolumeMl(450)).toBe(10)
    expect(autoVolumeMl(600)).toBe(10)
    expect(autoVolumeMl(0)).toBeNull()
    expect(autoVolumeMl(null)).toBeNull()
  })
})

describe('endo-prep: peptide prep', () => {
  it('10 mg in 1 mL: 100 uL sample + 900 uL LAL', () => {
    const p = calcEndoPrep({ sampleId: 'P-0101', declaredWeightMg: 10 })
    expect([p.volumeMl, p.vialConc, p.sampleUl, p.lalUl]).toEqual([
      1, 10, 100, 900,
    ])
    expect(p.isWater).toBe(false)
    expect(p.warning).toBeNull()
  })

  it('120 mg in 3 mL: 25 + 975', () => {
    const p = calcEndoPrep({ sampleId: 'P-0102', declaredWeightMg: 120 })
    expect([p.vialConc, p.sampleUl, p.lalUl]).toEqual([40, 25, 975])
  })

  it('600 mg hits the 10 mL cap: 60 mg/mL, 16.7 / 983.3', () => {
    const p = calcEndoPrep({ sampleId: 'P-0104', declaredWeightMg: 600 })
    expect(p.volumeMl).toBe(10)
    expect(p.vialConc).toBe(60)
    expect(fmtUl(p.sampleUl)).toBe('16.7')
    expect(fmtUl(p.lalUl)).toBe('983.3')
  })

  it('an entered volume overrides the rule and is marked', () => {
    const p = calcEndoPrep({
      sampleId: 'P-0200',
      declaredWeightMg: 120,
      prepVolumeMl: 2,
    })
    expect(p.volumeMl).toBe(2)
    expect(p.autoVolumeMl).toBe(3)
    expect(p.volumeOverridden).toBe(true)
    expect(p.vialConc).toBe(60)
  })

  it('an entered weight overrides the declared quantity', () => {
    const p = calcEndoPrep({
      sampleId: 'P-2458',
      declaredWeightMg: 30,
      prepWeightMg: 10,
    })
    expect(p.weightMg).toBe(10)
    expect(p.weightOverridden).toBe(true)
    expect(p.sampleUl).toBe(100)
  })

  it('a half-filled row yields nulls, never NaN', () => {
    const p = calcEndoPrep({ sampleId: 'P-0300', declaredWeightMg: null })
    expect(p.sampleUl).toBeNull()
    expect(p.lalUl).toBeNull()
    expect(p.vialConc).toBeNull()
    expect(fmtUl(p.sampleUl)).toBe('')
  })

  it('flags 1 mg (no diluent) and 0.5 mg (over the cartridge)', () => {
    expect(calcEndoPrep({ sampleId: 'P-1', declaredWeightMg: 1 }).warning).toBe(
      'no_diluent'
    )
    expect(
      calcEndoPrep({ sampleId: 'P-1', declaredWeightMg: 0.5 }).warning
    ).toBe('over_cartridge')
  })
})

describe('endo-prep: bacteriostatic water', () => {
  it('is a 20x dilution by id or by sample type', () => {
    const byId = calcEndoPrep({ sampleId: 'BW-0105' })
    expect([
      byId.dilution,
      byId.sampleUl,
      byId.lalUl,
      byId.volumeMl,
      byId.vialConc,
    ]).toEqual([20, 50, 950, null, null])
    expect(byId.isWater).toBe(true)
    expect(isBacWater('P-0999', 'Bacteriostatic Water')).toBe(true)
    expect(isBacWater('P-0999', 'Peptide')).toBe(false)
  })

  it('honours a non-default factor', () => {
    const p = calcEndoPrep({ sampleId: 'BW-0106', prepDilutionFactor: 40 })
    expect([p.dilution, p.sampleUl, p.lalUl]).toEqual([40, 25, 975])
  })
})

describe('endo-prep: lab dates', () => {
  it('reads a timestamp in the lab time zone', () => {
    // 03:00Z on the 18th is still the evening of the 17th in Los Angeles.
    expect(labDate('2026-09-18T03:00:00Z', cal)).toBe('2026-09-17')
    expect(labDate('2026-09-17T16:30:00Z', cal)).toBe('2026-09-17')
    expect(labDate('2026-09-17T16:30:00', cal)).toBe('2026-09-17') // naive = UTC
    expect(labDate(null, cal)).toBeNull()
  })
})

describe('endo-prep: bench order and formatting', () => {
  it('orders by due date, then priority, then insertion', () => {
    const rows = [
      { id: 'A', due: '2026-09-18', priority: 'normal' },
      { id: 'B', due: '2026-09-16', priority: 'default' },
      { id: 'C', due: '2026-09-16', priority: 'expedited' },
      { id: 'D', due: '2026-09-16', priority: 'high' },
      { id: 'E', due: '2026-09-16', priority: null },
      { id: 'F', due: null, priority: 'expedited' },
    ]
    expect(orderForBench(rows, r => r).map(r => r.id)).toEqual([
      'C',
      'D',
      'B',
      'E',
      'A',
      'F',
    ])
  })

  it('formats microlitres to 1 decimal and the rest to 3', () => {
    expect(fmtUl(33.333)).toBe('33.3')
    expect(fmtUl(100)).toBe('100')
    expect(fmt(49.888888)).toBe('49.889')
    expect(fmt(null)).toBe('')
  })
})
