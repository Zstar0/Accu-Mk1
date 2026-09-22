import { describe, it, expect } from 'vitest'
import {
  CAPACITY,
  PROTOCOL,
  SAMPLE_CAPACITY,
  assess,
  calculatePrep,
  fmt2,
  fractions,
  freezePayload,
  layoutPlates,
  orderGroups,
  plateGrid,
  summarize,
  metaHeaderRows,
  plateMapRows,
  prepRows,
  quantStudioFiles,
  toCsv,
  wellListRows,
  wellsOf,
  QS_ATTRIBUTES,
  WELL_LIST_HEADER,
  type PcrSample,
} from '@/lib/pcr-plate'

const close = (a: number | undefined, b: number) =>
  expect(Math.abs((a ?? NaN) - b)).toBeLessThan(1e-9)
type Layout = ReturnType<typeof layoutPlates>
const plateOf = (L: Layout, i = 0) => {
  const pl = L.plates[i]
  if (!pl) throw new Error(`no plate ${i}`)
  return pl
}
const placementAt = (L: Layout, plate = 0, i = 0) => {
  const p = plateOf(L, plate).placements[i]
  if (!p) throw new Error(`no placement ${i} on plate ${plate}`)
  return p
}

function sample(
  id: string,
  order = '9001',
  extra: Partial<PcrSample> = {}
): PcrSample {
  return {
    itemId: Number(id.replace(/\D/g, '')),
    id,
    order,
    identity: 'Examplerelin',
    received: null,
    priority: 'normal',
    assessment: assess(null, null, 'normal'),
    frozen: null,
    ...extra,
  }
}
const fake = (n: number, order = '9001', from = 101) =>
  Array.from({ length: n }, (_, i) =>
    sample(`P-${String(from + i).padStart(4, '0')}`, order)
  )
const ids = (L: Layout, plate = 0) =>
  plateOf(L, plate).placements.map(p => `${p.id}@${p.row}${p.col}`)

/* --- reaction and reagent volumes (the workbook's own numbers) --- */

describe('calculatePrep', () => {
  it('reaction: 10 + 1 + 2.4 + 6.6 = 20 uL per well (Template!K20:N20)', () => {
    expect(PROTOCOL.rxn).toEqual({
      mm: 10,
      assayMix: 1,
      ipcMix: 2.4,
      template: 6.6,
    })
    close(calculatePrep(1, 1).perWell.total, 20)
  })

  it('mix ratios become the workbook fractions (Template!Q37:T37, K37:M37)', () => {
    expect(fractions(PROTOCOL.assayMixParts)).toEqual({
      'F Primer': 0.09,
      'R Primer': 0.09,
      Probe: 0.05,
      H2O: 0.77,
    })
    expect(fractions(PROTOCOL.ipcMixParts)).toEqual({
      IPC: 0.5,
      'IPC DNA': 0.1,
      H2O: 0.4,
    })
  })

  it('well counts: 2N+4 for MM and IPC, N+2 for BAC and FUN (Template!D39:G39)', () => {
    expect(PROTOCOL.wellCounts(0)).toEqual({ mm: 4, bac: 2, fun: 2, ipc: 4 })
    expect(PROTOCOL.wellCounts(48)).toEqual({
      mm: 100,
      bac: 50,
      fun: 50,
      ipc: 100,
    })
    expect(CAPACITY).toBe(48)
    expect(SAMPLE_CAPACITY).toBe(47)
  })

  it('the filled run: 48 wells at 1.4x reproduces Plate Map!E16:H16 and K16:M16', () => {
    const c = calculatePrep(48, 1.4)
    expect(c.bulk).toEqual({ mm: 1000, bac: 50, fun: 50, ipc: 240 })
    expect(c.bac.map(r => fmt2(r.pipette))).toEqual([
      '6.3',
      '6.3',
      '3.5',
      '53.9',
    ])
    expect(c.fun.map(r => fmt2(r.pipette))).toEqual([
      '6.3',
      '6.3',
      '3.5',
      '53.9',
    ])
    expect(c.ipc.map(r => fmt2(r.pipette))).toEqual(['168', '33.6', '134.4'])
    expect(c.bac.map(r => fmt2(r.base))).toEqual(['4.5', '4.5', '2.5', '38.5'])
    expect(c.ipc.map(r => fmt2(r.base))).toEqual(['120', '24', '96'])
  })

  it('the blank template: 0 samples at 1.1x reproduces Template!E16:H16, K16:M16', () => {
    const c = calculatePrep(0, 1.1)
    expect(c.bulk).toEqual({ mm: 40, bac: 2, fun: 2, ipc: 9.6 })
    ;[0.18, 0.18, 0.1, 1.54].forEach((v, i) => close(c.bac[i]?.base, v))
    ;[0.198, 0.198, 0.11, 1.694].forEach((v, i) => close(c.bac[i]?.pipette, v))
    ;[4.8, 0.96, 3.84].forEach((v, i) => close(c.ipc[i]?.base, v))
    ;[5.28, 1.056, 4.224].forEach((v, i) => close(c.ipc[i]?.pipette, v))
  })

  it('master mix is never scaled by the overage', () => {
    expect(calculatePrep(20, 1.4).bulk.mm).toBe(calculatePrep(20, 1).bulk.mm)
    expect(calculatePrep(20, 1.4).bulk.mm).toBe(10 * (2 * 20 + 4))
  })

  it('fmt2 trims float noise to two decimals', () => {
    expect(fmt2(6.300000000000001)).toBe('6.3')
    expect(fmt2(33.599999999999994)).toBe('33.6')
    expect(fmt2(11.858)).toBe('11.86')
  })
})

/* --- priority and turnaround --- */

describe('assess', () => {
  it('flags overdue, due today, and a marked priority', () => {
    expect(assess('2026-09-11', '2026-09-16', 'normal')).toEqual({
      due: '2026-09-11',
      urgency: 'overdue',
      flagged: true,
      reasons: ['Overdue, was due Sep 11'],
    })
    expect(assess('2026-09-16', '2026-09-16', 'normal')).toEqual({
      due: '2026-09-16',
      urgency: 'today',
      flagged: true,
      reasons: ['Due today'],
    })
    expect(assess('2026-09-18', '2026-09-16', 'normal').flagged).toBe(false)
    expect(assess('2026-09-18', '2026-09-16', 'expedited').reasons).toEqual([
      'Expedited',
    ])
    expect(assess('2026-09-18', '2026-09-16', 'high').reasons).toEqual([
      'High priority',
    ])
    expect(assess(null, '2026-09-16', 'normal')).toEqual({
      due: null,
      urgency: '',
      flagged: false,
      reasons: [],
    })
  })
})

/* --- layout --- */

describe('layoutPlates', () => {
  it('fills column-major, mirrors into the fungal block, NPC after the last sample', () => {
    const L = layoutPlates(fake(9))
    expect(L.plateCount).toBe(1)
    expect(
      ids(L)
        .slice(0, 9)
        .map(s => s.split('@')[1])
    ).toEqual(['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'H1', 'A2'])
    expect(ids(L)[9]).toBe('NPC@B2')
    expect(placementAt(L, 0, 9).isControl).toBe(true)
    expect(plateOf(L).n).toBe(10)
    const map = plateGrid(plateOf(L))
    expect(map.get('A1')?.placement.id).toBe('P-0101')
    expect(map.get('A7')?.placement.id).toBe('P-0101')
    expect(map.get('A1')?.assay).toBe('bac')
    expect(map.get('A7')?.assay).toBe('fun')
    expect(map.get('B8')?.placement.id).toBe('NPC')
    expect(wellsOf(placementAt(L), 1)).toBe('A1 / A7')
    expect(wellsOf(placementAt(L), 2)).toBe('P1 A1 / A7')
    expect(L.list.length).toBe(10)
    expect(L.list.at(-1)?.isControl).toBe(true)
  })

  it('an empty worksheet is one empty plate with no NPC', () => {
    const L = layoutPlates([])
    expect(L.plateCount).toBe(1)
    expect(plateOf(L).placements).toEqual([])
    expect(L.list).toEqual([])
  })

  it('a full plate: 47 samples + NPC puts the NPC in H6 and H12, as the workbook does', () => {
    const L = layoutPlates(fake(47))
    expect(L.plateCount).toBe(1)
    const npc = plateOf(L).placements.find(p => p.isControl)
    expect(`${npc?.row}${npc?.col}`).toBe('H6')
    expect(plateGrid(plateOf(L)).get('H12')?.placement.id).toBe('NPC')
  })

  it('48 samples spill onto a second, complete plate with its own NPC', () => {
    const L = layoutPlates(fake(48))
    expect(L.plateCount).toBe(2)
    expect(L.plates.map(pl => pl.sampleCount)).toEqual([47, 1])
    expect(ids(L, 1)).toEqual(['P-0148@A1', 'NPC@B1'])
    expect(L.list.length).toBe(49)
    expect(L.list.at(-1)?.placements.length).toBe(2)
  })

  it('well order: by order number, then the worksheet order; no order last', () => {
    const s = [
      sample('A-1', '7500'),
      sample('A-2', '7400'),
      sample('A-3', '7500'),
      sample('A-4', ''),
      sample('B-1', '7100'),
      sample('B-2', '7000'),
    ]
    const only = (L: Layout) =>
      plateOf(L)
        .placements.filter(p => !p.isControl)
        .map(p => p.id)
    expect(only(layoutPlates(s))).toEqual([
      'B-2',
      'B-1',
      'A-2',
      'A-1',
      'A-3',
      'A-4',
    ])
    expect(only(layoutPlates(s, { sortByOrder: false }))).toEqual([
      'A-1',
      'A-2',
      'A-3',
      'A-4',
      'B-1',
      'B-2',
    ])
    const groups = orderGroups(layoutPlates(s).plates)
    expect(groups.map(g => [g.order, g.from, g.to, g.count])).toEqual([
      ['7000', 'A1', 'A1', 1],
      ['7100', 'B1', 'B1', 1],
      ['7400', 'C1', 'C1', 1],
      ['7500', 'D1', 'E1', 2],
      ['', 'F1', 'F1', 1],
      ['', 'G1', 'G1', 1],
    ])
    expect(groups.at(-1)?.isControl).toBe(true)
  })

  it('summarize counts flags against the run date', () => {
    const run = '2026-09-16'
    const s = [
      sample('P-1', '1', { assessment: assess('2026-09-11', run, 'normal') }),
      sample('P-2', '1', { assessment: assess('2026-09-16', run, 'normal') }),
      sample('P-3', '1', {
        priority: 'expedited',
        assessment: assess('2026-09-18', run, 'expedited'),
      }),
      sample('P-4', '1', { assessment: assess('2026-09-18', run, 'normal') }),
    ]
    const S = summarize(layoutPlates(s))
    expect([S.samples, S.n, S.overdue, S.today, S.marked, S.flagged]).toEqual([
      4, 5, 1, 1, 1, 3,
    ])
    expect(S.earliestDue).toBe('2026-09-11')
    expect(S.prioText).toBe('3: 1 marked, 1 overdue, 1 due today')
    expect(summarize(layoutPlates([])).prioText).toBe('-')
  })
})

/* --- frozen wells (ruling 2026-09-22) --- */

describe('layoutPlates with frozen wells', () => {
  const frozenAt = (s: PcrSample, plate: number, pos: number): PcrSample => ({
    ...s,
    frozen: { plate, pos },
  })

  it('frozen samples stay where they were printed, whatever the sort says', () => {
    // Printed with 9002 before 9001 (sort was off); a re-sort must not move them.
    const s = [
      frozenAt(sample('P-1', '9002'), 1, 0),
      frozenAt(sample('P-2', '9001'), 1, 1),
    ]
    expect(ids(layoutPlates(s))).toEqual(['P-1@A1', 'P-2@B1', 'NPC@C1'])
    expect(freezePayload(layoutPlates(s))).toEqual([])
  })

  it('late additions take the wells after the last frozen one and the NPC stays last', () => {
    const s = [
      frozenAt(sample('P-1', '9002'), 1, 0),
      frozenAt(sample('P-2', '9002'), 1, 1),
      sample('P-3', '9001'), // would sort first, but the plate is loaded
    ]
    const L = layoutPlates(s)
    expect(ids(L)).toEqual(['P-1@A1', 'P-2@B1', 'P-3@C1', 'NPC@D1'])
    expect(plateOf(L).placements.map(p => p.frozen)).toEqual([
      true,
      true,
      false,
      false,
    ])
    expect(freezePayload(L)).toEqual([{ item_id: 3, plate_no: 1, well_pos: 2 }])
    expect(L.frozenCount).toBe(2)
  })

  it('a removed sample leaves its well empty; it is never re-issued', () => {
    const s = [
      frozenAt(sample('P-1'), 1, 0),
      frozenAt(sample('P-3'), 1, 2),
      sample('P-4'),
    ]
    const L = layoutPlates(s)
    expect(ids(L)).toEqual(['P-1@A1', 'P-3@C1', 'P-4@D1', 'NPC@E1'])
    expect(plateGrid(plateOf(L)).has('B1')).toBe(false)
  })

  it('a full frozen plate spills late additions to the next plate', () => {
    const s = fake(47)
      .map((x, i) => frozenAt(x, 1, i))
      .concat(fake(2, '9001', 200))
    const L = layoutPlates(s)
    expect(L.plateCount).toBe(2)
    expect(ids(L, 0).at(-1)).toBe('NPC@H6')
    expect(ids(L, 1)).toEqual(['P-0200@A1', 'P-0201@B1', 'NPC@C1'])
    expect(freezePayload(L)).toEqual([
      { item_id: 200, plate_no: 2, well_pos: 0 },
      { item_id: 201, plate_no: 2, well_pos: 1 },
    ])
  })

  it('order groups follow the wells as laid out, across a plate boundary', () => {
    const s = fake(46, '9001').concat(fake(3, '9002', 300))
    const groups = orderGroups(layoutPlates(s).plates).filter(g => !g.isControl)
    expect(groups.map(g => [g.plate, g.order, g.count])).toEqual([
      [1, '9001', 46],
      [1, '9002', 1],
      [2, '9002', 2],
    ])
  })
})

/* --- exports --- */

describe('exports', () => {
  const meta = {
    runId: 'WS-24',
    runName: 'PCR 09/22/2026',
    date: '2026-09-22',
    analyst: 'Guian',
    curve: 'Quantitative',
    plateType: '8-Well Strip',
    instrument: 'QuantStudio 6 Flex',
    overage: 1.4,
  }

  it('well list: one row per occupied well in both blocks, the NPC as task NTC', () => {
    const rows = wellListRows(layoutPlates(fake(2)))
    expect(rows[0]).toEqual(WELL_LIST_HEADER)
    expect(rows.length).toBe(1 + 3 * 2)
    const npc = rows.filter(r => r[2] === 'NPC')
    expect(npc.map(r => [r[1], r[8], r[9], r[10]])).toEqual([
      ['C1', 'Bacterial', '16S', 'NTC'],
      ['C7', 'Fungal', '18S', 'NTC'],
    ])
    expect(rows[1]?.[10]).toBe('UNKNOWN')
  })

  it('plate map: two 8 x 12 grids per plate, ids then identities', () => {
    const rows = plateMapRows(layoutPlates(fake(1)))
    expect(rows[0]).toEqual(['Plate 1 of 1: Sample ID'])
    expect(rows[1]).toEqual([
      '',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
    ])
    expect(rows[2]?.[1]).toBe('P-0101')
    expect(rows[2]?.[7]).toBe('P-0101')
    expect(rows[3]?.[1]).toBe('NPC')
    expect(rows[11]).toEqual(['Plate 1 of 1: Sample identity'])
    expect(rows[13]?.[1]).toBe('Examplerelin')
    expect(rows[14]?.[7]).toBe('No-template control')
  })

  it('the run header leads the plate map CSV', () => {
    const rows = metaHeaderRows(meta, layoutPlates(fake(1)))
    expect(rows[0]).toEqual(['Run ID', 'WS-24'])
    expect(rows[7]).toEqual(['Samples', '1'])
    expect(rows[9]).toEqual(['Overage', '1.4x'])
    expect(rows.at(-1)).toEqual([])
  })

  it('prepRows carries the calculation cards for every plate', () => {
    const rows = prepRows(layoutPlates(fake(8)), 1.4)
    expect(rows[1]).toEqual(['1', 'Wells', 'Wells on plate (N)', '9', ''])
    expect(rows[2]).toEqual(['1', 'Wells', 'Master mix wells', '22', ''])
    const h2o = rows.find(r => r[1] === 'BAC mix' && r[2] === 'H2O')
    expect(h2o).toEqual(['1', 'BAC mix', 'H2O', '8.47', '11.86'])
  })

  it('QuantStudio file: tab-delimited, Sample Name first, 7 attributes, one row per well pair, no tabs in values', () => {
    const s = sample('P-0101', '9001', {
      identity: 'Exam\tplerelin',
      received: '2026-09-11',
      assessment: assess('2026-09-16', '2026-09-16', 'normal'),
    })
    const files = quantStudioFiles(layoutPlates([s]), {
      runId: 'WS-24',
      date: '2026-09-16',
    })
    expect(files.length).toBe(1)
    const lines = (files[0]?.text ?? '').split('\r\n')
    expect(lines[0]).toBe(['Sample Name', ...QS_ATTRIBUTES].join('\t'))
    expect(QS_ATTRIBUTES.length).toBe(7)
    expect(lines[1]).toBe(
      'P-0101\t9001\tExam plerelin\t2026-09-11\t2026-09-16\tDue today\t1\tA1; A7'
    )
    expect(lines[2]).toBe('NPC\t\tNo-template control\t\t\t\t1\tB1; B7')
    expect(lines[3]).toBe('')
    expect(files[0]?.filename).toBe('quantstudio-WS-24-2026-09-16.txt')
    const two = quantStudioFiles(layoutPlates(fake(48)), {
      runId: 'WS-24',
      date: '2026-09-16',
    })
    expect(two.map(f => f.filename)).toEqual([
      'quantstudio-WS-24-plate1-2026-09-16.txt',
      'quantstudio-WS-24-plate2-2026-09-16.txt',
    ])
  })

  it('toCsv quotes where needed and defuses a formula cell', () => {
    expect(toCsv([['a', 'x, y'], ['=1+1', ''], []])).toBe(
      'a,"x, y"\r\n"\'=1+1",\r\n\r\n'
    )
  })
})
