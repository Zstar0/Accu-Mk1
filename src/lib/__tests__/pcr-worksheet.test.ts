import { describe, it, expect } from 'vitest'
import type { WorksheetListItem } from '@/lib/api'
import type { LabCalendar } from '@/lib/endo-prep'
import {
  buildPcrRunDoc,
  pcrConfigOf,
  pcrConfigToWire,
  pcrLayoutKindOf,
  pcrRunDate,
  pcrSamplesFor,
  plateLabel,
} from '@/lib/pcr-worksheet'

const cal: LabCalendar = {
  timezone: 'America/Los_Angeles',
  workingDays: [0, 1, 2, 3, 4],
  holidays: new Map(),
}

function item(
  id: number,
  overrides: Partial<WorksheetListItem['items'][number]> = {}
): WorksheetListItem['items'][number] {
  return {
    id,
    sample_id: `P-3001-S0${id}`,
    sample_uid: `mk1://pcr-${id}`,
    service_group_id: null,
    department_id: 3,
    department_name: 'Microbiology',
    group_name: '-',
    group_color: 'zinc',
    priority: 'normal',
    added_at: '2026-09-21T16:00:00Z',
    date_received: '2026-09-21T16:00:00Z',
    instrument_uid: null,
    instrument_id: null,
    assigned_analyst_id: null,
    assigned_analyst_email: null,
    notes: null,
    peptide_id: null,
    method_name: null,
    stamped_method_name: null,
    stamped_instrument_name: null,
    lims_sub_sample_pk: id,
    assignment_role: 'pcr',
    box_id: null,
    box_label: null,
    analyses: [
      {
        title: 'Rapid Sterility Screening (PCR)',
        keyword: 'STERILITY-PCR',
        peptide_name: null,
        method: null,
      },
    ],
    prep_status: 'ready',
    client_order_number: 'WP-8120',
    sample_identity: 'BPC-157',
    ...overrides,
  }
}

function worksheet(
  items: WorksheetListItem['items'],
  extra: Partial<WorksheetListItem> = {}
): WorksheetListItem {
  return {
    id: 24,
    title: 'PCR 09/22/2026',
    status: 'open',
    notes: null,
    assigned_analyst: null,
    assigned_analyst_email: null,
    item_count: items.length,
    created_at: '2026-09-22T15:00:00Z',
    completed_at: null,
    items,
    ...extra,
  }
}

describe('pcrConfigOf', () => {
  it('reads bench_config with defaults for anything missing or bad', () => {
    expect(pcrConfigOf({ bench_config: null })).toEqual({
      overage: 1.1,
      curve: '',
      plateType: '',
      sort: { key: 'order', dir: 'asc' },
      pins: { samples: {}, npc: {} },
    })
    expect(
      pcrConfigOf({
        bench_config: {
          overage: 'x',
          curve: 'P/A',
          plate_type: 7,
          sort_by_order: false,
        },
      })
    ).toEqual({
      overage: 1.1,
      curve: 'P/A',
      plateType: '',
      sort: { key: 'listed', dir: 'asc' },
      pins: { samples: {}, npc: {} },
    })
  })

  it('reads the saved column sort, falling back on anything unknown', () => {
    const sortOf = (c: Record<string, unknown>) =>
      pcrConfigOf({ bench_config: c }).sort
    expect(sortOf({ sort_key: 'due', sort_dir: 'desc' })).toEqual({
      key: 'due',
      dir: 'desc',
    })
    // The saved column wins over the older on/off switch.
    expect(
      sortOf({ sort_key: 'priority', sort_dir: 'asc', sort_by_order: false })
    ).toEqual({ key: 'priority', dir: 'asc' })
    expect(sortOf({ sort_key: 'nonsense', sort_dir: 'desc' })).toEqual({
      key: 'order',
      dir: 'asc',
    })
    expect(sortOf({ sort_key: 'due', sort_dir: 'sideways' })).toEqual({
      key: 'due',
      dir: 'asc',
    })
  })

  it('a 1.4 saved before Rev E was the old default, not a choice', () => {
    const of = (c: Record<string, unknown>) =>
      pcrConfigOf({ bench_config: c }).overage
    expect(of({ overage: 1.4 })).toBe(1.1)
    expect(of({ overage: 1.25 })).toBe(1.25)
    // Saved by this build: the analyst did ask for 1.4.
    expect(of({ overage: 1.4, rev: 'E' })).toBe(1.4)
  })

  it('writes the sort back, keeping the older switch in step', () => {
    const wire = (key: 'order' | 'due') =>
      pcrConfigToWire({
        overage: 1.1,
        curve: 'Q',
        plateType: 'S',
        sort: { key, dir: 'desc' },
        pins: { samples: {}, npc: {} },
      })
    expect(wire('due')).toEqual({
      rev: 'E',
      overage: 1.1,
      curve: 'Q',
      plate_type: 'S',
      sort_key: 'due',
      sort_dir: 'desc',
      sort_by_order: false,
    })
    expect(wire('order').sort_by_order).toBe(true)
    expect(pcrConfigOf({ bench_config: wire('due') }).sort).toEqual({
      key: 'due',
      dir: 'desc',
    })
  })
})

describe('pcrSamplesFor', () => {
  it('turns PCR items into samples with lab dates, order, identity and the frozen well', () => {
    const due = new Map([
      [1, '2026-09-24T22:59:00Z'],
      [2, null],
    ])
    const [a, b] = pcrSamplesFor(
      [
        item(1, { plate_no: 1, well_pos: 5 }),
        item(2, { assignment_role: 'ster' }),
        item(3, { assignment_role: 'endo' }),
      ],
      due,
      cal,
      '2026-09-22'
    )
    if (!a || !b) throw new Error('expected two PCR samples')
    expect(a).toMatchObject({
      itemId: 1,
      id: 'P-3001-S01',
      order: '8120',
      identity: 'BPC-157',
      received: '2026-09-21',
      frozen: { plate: 1, pos: 5 },
    })
    expect(a.assessment).toMatchObject({
      due: '2026-09-24',
      urgency: 'later',
      flagged: false,
    })
    expect(b.frozen).toBeNull()
    expect(b.assessment.due).toBeNull()
  })

  it('runs are judged against today while open and the completion day once completed', () => {
    expect(pcrRunDate(worksheet([]), cal)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(
      pcrRunDate(
        worksheet([], {
          status: 'completed',
          completed_at: '2026-09-23T03:00:00Z',
        }),
        cal
      )
    ).toBe('2026-09-22')
    expect(pcrRunDate(worksheet([]), null)).toBeNull()
  })

  it('plateLabel drops a vial suffix for the well only', () => {
    expect(plateLabel('P-3001-S02')).toBe('P-3001')
    expect(plateLabel('BW-0105-S03')).toBe('BW-0105')
    expect(plateLabel('NPC')).toBe('NPC')
  })
})

describe('buildPcrRunDoc', () => {
  it('lays the worksheet out and counts the run status', () => {
    const ws = worksheet(
      [
        item(1, {
          made_at: '2026-09-22T16:00:00Z',
          ran_at: '2026-09-22T17:00:00Z',
          stamped_instrument_name: 'QuantStudio 6 Flex',
        }),
        item(2, { made_at: '2026-09-22T16:00:00Z' }),
      ],
      { bench_config: { overage: 1.1, curve: 'Quantitative' } }
    )
    const doc = buildPcrRunDoc(ws, {
      analystName: 'Guian',
      calendar: cal,
      printedAt: 'Sep 22, 2026, 10:04 AM',
      dueAtByItemId: new Map(),
      notes: 'lot 42',
    })
    expect(doc.meta).toMatchObject({
      runId: 'WS-24',
      runName: 'PCR 09/22/2026',
      date: '2026-09-22',
      curve: 'Quantitative',
      overage: 1.1,
      instrument: 'QuantStudio 6 Flex',
    })
    expect(doc.layout.plates[0]?.placements.map(p => p.id)).toEqual([
      'P-3001-S01',
      'P-3001-S02',
      'NPC',
    ])
    expect(doc.status).toEqual({ made: 2, ran: 1, total: 2 })
    expect(doc.summary.samples).toBe(2)
    expect(doc.notes).toBe('lot 42')
  })
  it('keeps the frozen well of a removed sample empty through the worksheet record', () => {
    // Printed with three samples in A1..C1; the one in C1 was removed.
    const ws = worksheet(
      [
        item(1, { plate_no: 1, well_pos: 0 }),
        item(2, { plate_no: 1, well_pos: 1 }),
        item(4),
      ],
      { well_high_water: { '1': 2 } }
    )
    const doc = buildPcrRunDoc(ws, {
      analystName: '',
      calendar: cal,
      printedAt: '',
      dueAtByItemId: new Map(),
      notes: '',
    })
    expect(
      doc.layout.plates[0]?.placements.map(p => `${p.id}@${p.row}${p.col}`)
    ).toEqual(['P-3001-S01@A1', 'P-3001-S02@B1', 'P-3001-S04@D1', 'NPC@E1'])
  })
})

describe('pcrLayoutKindOf', () => {
  const ws = (over: Record<string, unknown>) =>
    ({
      bench_config: null,
      well_high_water: null,
      status: 'open',
      items: [item(1)],
      ...over,
    }) as Parameters<typeof pcrLayoutKindOf>[0]

  it('an unlocked open worksheet fills from the middle', () => {
    expect(pcrLayoutKindOf(ws({}))).toBe('mid')
  })

  it('a plate locked or completed before the stamp existed keeps the old map', () => {
    expect(
      pcrLayoutKindOf(ws({ items: [item(1, { plate_no: 1, well_pos: 0 })] }))
    ).toBe('legacy')
    // Its only locked sample was removed: the record still says a plate is out.
    expect(pcrLayoutKindOf(ws({ well_high_water: { '1': 3 } }))).toBe('legacy')
    expect(pcrLayoutKindOf(ws({ status: 'completed' }))).toBe('legacy')
  })

  it('the server stamp wins over everything else', () => {
    expect(
      pcrLayoutKindOf(
        ws({
          bench_config: { layout: 'mid' },
          status: 'completed',
          items: [item(1, { plate_no: 1, well_pos: 0 })],
        })
      )
    ).toBe('mid')
    expect(pcrLayoutKindOf(ws({ bench_config: { layout: 'legacy' } }))).toBe(
      'legacy'
    )
    expect(pcrLayoutKindOf(ws({ bench_config: { layout: 'spiral' } }))).toBe(
      'mid'
    )
  })
})

describe('hand placements in bench_config', () => {
  const pins = {
    samples: { 7: { plate: 1, pos: 9 }, 8: { plate: 1, pos: 0, held: true } },
    npc: { 1: { pos: 20 } },
  }

  it('round-trips through the wire shape and is left out when there are none', () => {
    const cfg = { ...pcrConfigOf({ bench_config: null }), pins }
    const wire = pcrConfigToWire(cfg)
    expect(wire.pins).toEqual(pins)
    expect(pcrConfigOf({ bench_config: wire }).pins).toEqual(pins)
    expect('pins' in pcrConfigToWire(pcrConfigOf({ bench_config: null }))).toBe(
      false
    )
  })

  it('drops anything malformed rather than guess a well', () => {
    const read = (p: unknown) => pcrConfigOf({ bench_config: { pins: p } }).pins
    expect(read('x')).toEqual({ samples: {}, npc: {} })
    expect(
      read({
        samples: {
          7: { plate: 1, pos: '9' },
          x: { plate: 1, pos: 1 },
          9: null,
        },
        npc: { 1: { pos: 1.5 } },
      })
    ).toEqual({ samples: {}, npc: {} })
  })

  it('places the worksheet by its saved pins', () => {
    const ws = worksheet([item(1), item(2)], {
      bench_config: {
        pins: { samples: { 1: { plate: 1, pos: 12 } }, npc: {} },
      },
    })
    const doc = buildPcrRunDoc(ws, {
      analystName: 'Guian',
      calendar: cal,
      printedAt: '',
      dueAtByItemId: new Map(),
      notes: '',
    })
    expect(
      doc.layout.plates[0]?.placements.map(p => `${p.id}@${p.pos}`)
    ).toEqual(['P-3001-S02@0', 'P-3001-S01@12', 'NPC@13'])
  })
})
