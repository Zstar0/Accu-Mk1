import { describe, it, expect } from 'vitest'
import {
  CAPACITY,
  PROTOCOL,
  SAMPLE_CAPACITY,
  assess,
  applyWellMoves,
  calculatePrep,
  fillGaps,
  hasGaps,
  planWellMove,
  posOf,
  NO_PINS,
  type PcrPins,
  extractionWater,
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

  it('a plate holds 48 reactions per well set, 47 samples and the NPC', () => {
    expect(PROTOCOL.reactions(9)).toEqual({ perSet: 9, total: 18 })
    expect(CAPACITY).toBe(48)
    expect(SAMPLE_CAPACITY).toBe(47)
  })

  // The two runs calc.test.js pins (tools-dennis): SOP-MICRO2601 Rev E 8.3's
  // 8-reaction count and a full plate.
  it('SOP 8.1: 8 reactions make 107.2 uL of premix per set, 117.92 with 10% overage', () => {
    const c = calculatePrep(8, 1.1)
    expect(c.perWell.premix).toBe(13.4)
    close(c.premix.base.mm, 80)
    close(c.premix.base.assayMix, 8)
    close(c.premix.base.ipcMix, 19.2)
    close(c.premix.base.total, 107.2)
    close(c.premix.pipette.mm, 88)
    close(c.premix.pipette.assayMix, 8.8)
    close(c.premix.pipette.ipcMix, 21.12)
    close(c.premix.pipette.total, 117.92)
  })

  it('a full plate: 48 reactions make 643.2 uL per set, 707.52 with overage', () => {
    const c = calculatePrep(48, 1.1)
    close(c.premix.base.total, 643.2)
    expect(Object.values(c.premix.pipette).map(fmt2)).toEqual([
      '528',
      '52.8',
      '126.72',
      '707.52',
    ])
    // The mixes split one set's volume by the workbook recipes.
    expect(c.bac.map(r => fmt2(r.base))).toEqual([
      '4.32',
      '4.32',
      '2.4',
      '36.96',
    ])
    expect(c.fun).toEqual(c.bac)
    expect(c.ipc.map(r => fmt2(r.base))).toEqual(['57.6', '11.52', '46.08'])
  })

  it('the overage scales the whole premix, master mix included', () => {
    expect(calculatePrep(20, 1.4).premix.pipette.mm).toBe(10 * 20 * 1.4)
    expect(calculatePrep(20, 1).premix.pipette).toEqual(
      calculatePrep(20, 1).premix.base
    )
  })

  it('elution water: 100 uL per extraction at the same overage (Dennis, 2026-11-09)', () => {
    const w = extractionWater(17, 1.1)
    expect(w.base).toBe(1700)
    close(w.pipette, 1870)
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
    expect(rows[14]?.[7]).toBe('Negative process control')
  })

  it('the run header leads the plate map CSV', () => {
    const rows = metaHeaderRows(meta, layoutPlates(fake(1)))
    expect(rows[0]).toEqual(['Run ID', 'WS-24'])
    expect(rows[7]).toEqual(['Samples', '1'])
    expect(rows[9]).toEqual(['Overage', '1.4x'])
    expect(rows.at(-1)).toEqual([])
  })

  it('prepRows carries the calculation cards for every plate', () => {
    const rows = prepRows(layoutPlates(fake(8)), 1.1)
    expect(rows[1]).toEqual(['1', 'Reactions', 'Samples on plate', '8', ''])
    expect(rows[3]).toEqual([
      '1',
      'Reactions',
      'Reactions per well set (N)',
      '9',
      '',
    ])
    expect(rows.find(r => r[1] === 'Extraction' && r[3] !== '9')).toEqual([
      '1',
      'Extraction',
      'Elution water at 65 C (100 uL each)',
      '900',
      '990',
    ])
    const set = (item: string) =>
      rows.find(r => r[1] === 'Premix per well set' && r[2] === item)
    expect(set('Total')).toEqual([
      '1',
      'Premix per well set',
      'Total',
      '120.6',
      '132.66',
    ])
    const h2o = rows.find(
      r => r[1] === 'Set A assay mix (16S)' && r[2] === 'H2O'
    )
    expect(h2o?.slice(3)).toEqual(['6.93', '7.62'])
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
    expect(lines[2]).toBe('NPC\t\tNegative process control\t\t\t\t1\tB1; B7')
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

/* --- a frozen well stays spent after its sample is removed (review 2026-09-22) --- */

describe('layoutPlates with the issued-well record', () => {
  const frozenAt = (s: PcrSample, plate: number, pos: number): PcrSample => ({
    ...s,
    frozen: { plate, pos },
  })
  // Printed A1..F1 with the NPC in G1; F1's sample (pos 5) was then removed.
  const kept = () =>
    [0, 1, 2, 3, 4].map(i => frozenAt(sample(`P-10${i}`), 1, i))

  it('the removed last well stays empty: a late addition goes after it', () => {
    const L = layoutPlates([...kept(), sample('P-200')], {
      highWater: { 1: 5 },
    })
    expect(ids(L).slice(5)).toEqual(['P-200@G1', 'NPC@H1'])
    expect(plateGrid(plateOf(L)).has('F1')).toBe(false)
    expect(freezePayload(L)).toEqual([
      { item_id: 200, plate_no: 1, well_pos: 6 },
    ])
  })

  it('with no late addition the NPC keeps its well rather than moving into the vacated one', () => {
    const L = layoutPlates(kept(), { highWater: { 1: 5 } })
    expect(ids(L).at(-1)).toBe('NPC@G1')
    expect(plateGrid(plateOf(L)).has('F1')).toBe(false)
  })

  it('a plate whose issued wells reach 47 sends late additions to the next plate', () => {
    // 46 samples frozen at pos 0..45; the one at pos 46 (G6) was removed.
    const frozen = fake(46).map((x, i) => frozenAt(x, 1, i))
    const L = layoutPlates([...frozen, sample('P-0900')], {
      highWater: { 1: 46 },
    })
    expect(ids(L, 0).at(-1)).toBe('NPC@H6')
    expect(ids(L, 1)).toEqual(['P-0900@A1', 'NPC@B1'])
  })

  it('without a record the highest frozen well still counts, as before', () => {
    const L = layoutPlates([...kept(), sample('P-200')])
    expect(ids(L).slice(5)).toEqual(['P-200@F1', 'NPC@G1'])
  })
})

// Dennis, 2026-10-26: fill from the middle of the block outward, Set B the
// mirror of Set A. The same fill positions, drawn on other wells.
describe('the middle-out well map', () => {
  const mid = (n: number) => layoutPlates(fake(n), { kind: 'mid' })
  const wells = (L: Layout, i: number) => wellsOf(placementAt(L, 0, i), 1)

  it('starts at A6 / A7 and fans out to A1 / A12', () => {
    const L = mid(47)
    expect(L.kind).toBe('mid')
    expect(wells(L, 0)).toBe('A6 / A7')
    expect(wells(L, 7)).toBe('H6 / H7')
    expect(wells(L, 8)).toBe('A5 / A8')
    expect(wells(L, 40)).toBe('A1 / A12')
    // 47 samples fill the block; the NPC takes its last well.
    expect(wells(L, 47)).toBe('H1 / H12')
    expect(placementAt(L, 0, 47).isControl).toBe(true)
  })

  it('positions are the same as before; only the wells differ', () => {
    const a = mid(10)
    const b = layoutPlates(fake(10), { kind: 'legacy' })
    expect(freezePayload(a)).toEqual(freezePayload(b))
    expect(wells(b, 0)).toBe('A1 / A7')
    expect(b.kind).toBe('legacy')
  })

  it('draws both wells of a sample on the grid and in the QuantStudio file', () => {
    const L = mid(2)
    const grid = plateGrid(plateOf(L))
    expect(grid.get('A6')?.assay).toBe('bac')
    expect(grid.get('A7')?.assay).toBe('fun')
    expect(grid.get('A6')?.placement).toBe(grid.get('A7')?.placement)
    expect(grid.get('C6')?.placement.isControl).toBe(true)
    expect(grid.get('C7')?.placement.isControl).toBe(true)
    expect(grid.has('A1')).toBe(false)
    const [file] = quantStudioFiles(L, { runId: 'WS-1', date: '2026-11-12' })
    expect(file?.text.split('\r\n')[1]?.endsWith('\tA6; A7')).toBe(true)
  })

  it('a locked well keeps its position, so a late addition lands beside it', () => {
    const locked = fake(2).map((s, i) => ({
      ...s,
      frozen: { plate: 1, pos: i },
    }))
    const L = layoutPlates([...locked, sample('P-0099')], { kind: 'mid' })
    expect(wells(L, 0)).toBe('A6 / A7')
    expect(wells(L, 2)).toBe('C6 / C7')
    expect(placementAt(L, 0, 3).isControl).toBe(true)
    expect(wells(L, 3)).toBe('D6 / D7')
  })
})

// Rearrange (Dennis, 2026-10-26; asked for in Mk1 2026-11-20): wells moved
// by hand before the print. calc.test.js pins the same rules on his sheet.
describe('wells placed by hand', () => {
  const lay = (n: number, pins: PcrPins = NO_PINS, extra: PcrSample[] = []) =>
    layoutPlates([...fake(n), ...extra], { kind: 'mid', pins })
  const at = (L: Layout) => plateOf(L).placements.map(p => `${p.id}@${p.pos}`)
  const move = (
    L: Layout,
    selected: number[],
    toPos: number,
    anchor?: number
  ) => {
    const plan = planWellMove(L, 1, selected, toPos, anchor)
    if (!plan.ok) throw new Error(plan.reason)
    return applyWellMoves(L, 1, plan.moves)
  }
  const ids = fake(4).map(s => s.id)

  it('a move leaves its well empty and holds every other well, the NPC too', () => {
    const L0 = lay(4)
    const pins = move(L0, [1], 9)
    const L = lay(4, pins)
    expect(at(L)).toEqual([
      `${ids[0]}@0`,
      `${ids[2]}@2`,
      `${ids[3]}@3`,
      `${ids[1]}@9`,
      'NPC@4',
    ])
    const moved = plateOf(L).placements.find(p => p.pos === 9)
    expect(moved?.pinned).toBe(true)
    expect(plateOf(L).placements.filter(p => p.pinned).length).toBe(1)
    expect(L.pinnedCount).toBe(4)
    expect(hasGaps(plateOf(L))).toBe(true)
    expect(hasGaps(plateOf(L0))).toBe(false)
    // In the middle-out map position 9 is B5 and its pair B8.
    expect(wellsOf(moved as NonNullable<typeof moved>, 1)).toBe('B5 / B8')
  })

  it('a sample added later flows into the first open well', () => {
    const pins = move(lay(4), [1], 9)
    const L = lay(4, pins, [sample('P-0099')])
    expect(plateOf(L).placements.find(p => p.id === 'P-0099')?.pos).toBe(1)
  })

  it('a selection shifts together, and the dragged well lands on the target', () => {
    const L0 = lay(4)
    expect(at(lay(4, move(L0, [0, 1], 8))).slice(0, 4)).toEqual([
      `${ids[2]}@2`,
      `${ids[3]}@3`,
      `${ids[0]}@8`,
      `${ids[1]}@9`,
    ])
    // Dragging the second of the two onto position 9: the first lands on 8.
    expect(planWellMove(L0, 1, [0, 1], 9, 1).moves).toEqual([
      { from: 0, to: 8 },
      { from: 1, to: 9 },
    ])
  })

  it('refuses a target that is taken or off the plate, naming the well', () => {
    const L = lay(4)
    const taken = planWellMove(L, 1, [0], 2)
    expect(taken.ok).toBe(false)
    expect(taken.reason).toBe(`C6 is taken by ${ids[2]}; nothing moved.`)
    expect(planWellMove(L, 1, [2, 3], 47, 2).ok).toBe(false)
    expect(planWellMove(L, 1, [0], -1).ok).toBe(false)
    expect(planWellMove(L, 1, [], 5).ok).toBe(false)
    // Onto each other inside the selection is fine: both move.
    expect(planWellMove(L, 1, [3, 4], 4).ok).toBe(true)
  })

  it('the NPC moves like any other well and is pinned per plate', () => {
    const L = lay(4, move(lay(4), [4], 20))
    const npc = plateOf(L).placements.find(p => p.isControl)
    expect(npc?.pos).toBe(20)
    expect(npc?.pinned).toBe(true)
  })

  it('Fill gaps packs the plate in the order it is in now; the NPC trails again', () => {
    const moved = lay(4, move(lay(4), [0], 30))
    const L = lay(4, fillGaps(moved))
    expect(at(L)).toEqual([
      `${ids[1]}@0`,
      `${ids[2]}@1`,
      `${ids[3]}@2`,
      `${ids[0]}@3`,
      'NPC@4',
    ])
    expect(hasGaps(plateOf(L))).toBe(false)
    // The hand-placed well keeps its mark.
    expect(plateOf(L).placements.find(p => p.id === ids[0])?.pinned).toBe(true)
  })

  it('a printed plate is locked: a lock beats a pin and nothing can be moved', () => {
    const locked = fake(2).map((s, i) => ({
      ...s,
      frozen: { plate: 1, pos: i },
    }))
    const L = layoutPlates(locked, {
      kind: 'mid',
      pins: {
        samples: { [locked[0]?.itemId ?? 0]: { plate: 1, pos: 30 } },
        npc: {},
      },
    })
    expect(placementAt(L, 0, 0).pos).toBe(0)
    const plan = planWellMove(L, 1, [0], 30)
    expect(plan.ok).toBe(false)
    expect(plan.reason).toMatch(/unlock/i)
  })

  it('bad pins never lose a sample: off the plate or doubled up, it flows', () => {
    const [a, b, c] = fake(3)
    const L = lay(3, {
      samples: {
        [a?.itemId ?? 0]: { plate: 1, pos: 48 },
        [b?.itemId ?? 0]: { plate: 1, pos: 5 },
        [c?.itemId ?? 0]: { plate: 1, pos: 5 },
      },
      npc: { 1: { pos: 99 } },
    })
    expect(plateOf(L).placements.length).toBe(4)
    expect(new Set(plateOf(L).placements.map(p => p.pos)).size).toBe(4)
  })

  it('a pin naming a plate the run cannot have is ignored, not drawn', () => {
    const [a] = fake(1)
    const L = lay(1, {
      samples: { [a?.itemId ?? 0]: { plate: 1e9, pos: 3 } },
      npc: {},
    })
    expect(L.plateCount).toBe(1)
    expect(at(L)).toEqual([`${a?.id}@0`, 'NPC@1'])
  })

  it('a sample pinned to the last well leaves the NPC the first open one', () => {
    const [a] = fake(1)
    const L = lay(1, {
      samples: { [a?.itemId ?? 0]: { plate: 1, pos: 47 } },
      npc: {},
    })
    expect(at(L)).toEqual([`${a?.id}@47`, 'NPC@0'])
  })

  it('posOf reads a grid cell in either block back to its fill position', () => {
    expect(posOf('A', 6, 'mid')).toBe(0)
    expect(posOf('A', 7, 'mid')).toBe(0)
    expect(posOf('H', 1, 'mid')).toBe(47)
    expect(posOf('H', 12, 'mid')).toBe(47)
    expect(posOf('A', 1, 'legacy')).toBe(0)
    expect(posOf('B', 7, 'legacy')).toBe(1)
    expect(posOf('Z', 1, 'mid')).toBeNull()
  })
})
