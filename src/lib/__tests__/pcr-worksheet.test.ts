import { describe, it, expect } from 'vitest'
import type { WorksheetListItem } from '@/lib/api'
import type { LabCalendar } from '@/lib/endo-prep'
import {
  buildPcrRunDoc,
  pcrConfigOf,
  pcrConfigToWire,
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
      overage: 1.4,
      curve: '',
      plateType: '',
      sortByOrder: true,
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
      overage: 1.4,
      curve: 'P/A',
      plateType: '',
      sortByOrder: false,
    })
    expect(
      pcrConfigToWire({
        overage: 1.1,
        curve: 'Q',
        plateType: 'S',
        sortByOrder: true,
      })
    ).toEqual({
      overage: 1.1,
      curve: 'Q',
      plate_type: 'S',
      sort_by_order: true,
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
})
