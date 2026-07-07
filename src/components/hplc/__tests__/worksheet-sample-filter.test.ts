import { describe, it, expect } from 'vitest'
import {
  worksheetMatchesSampleQuery,
  findWorksheetForSample,
} from '../worksheet-sample-filter'
import type { WorksheetListItem } from '@/lib/api'

// Minimal WorksheetListItem builder — only the fields the predicate reads
// (items[].sample_id) matter; the rest satisfy the type.
function ws(sampleIds: string[], id = 1, title = 'WS-1'): WorksheetListItem {
  return {
    id,
    title,
    status: 'open',
    notes: null,
    assigned_analyst: null,
    assigned_analyst_email: null,
    item_count: sampleIds.length,
    created_at: null,
    completed_at: null,
    items: sampleIds.map((sid, i) => ({
      id: i,
      sample_id: sid,
      sample_uid: `uid-${i}`,
      service_group_id: null,
      group_name: '',
      group_color: '',
      priority: 'normal',
      added_at: null,
      date_received: null,
      instrument_uid: null,
      assigned_analyst_id: null,
      assigned_analyst_email: null,
      notes: null,
      peptide_id: null,
      method_name: null,
      lims_sub_sample_pk: null,
      box_id: null,
      box_label: null,
      analyses: [],
      prep_status: 'pending',
    })),
  }
}

describe('worksheetMatchesSampleQuery', () => {
  it('matches every worksheet for an empty or whitespace query', () => {
    expect(worksheetMatchesSampleQuery(ws(['P-0144']), '')).toBe(true)
    expect(worksheetMatchesSampleQuery(ws(['P-0144']), '   ')).toBe(true)
  })

  it('matches a case-insensitive substring of a sample id', () => {
    const w = ws(['P-0144', 'P-0200'])
    expect(worksheetMatchesSampleQuery(w, '144')).toBe(true)
    expect(worksheetMatchesSampleQuery(w, 'p-0144')).toBe(true)
    expect(worksheetMatchesSampleQuery(w, 'P-0200')).toBe(true)
  })

  it('returns false when no item sample id matches', () => {
    expect(worksheetMatchesSampleQuery(ws(['P-0144', 'P-0200']), 'P-9999')).toBe(false)
  })

  it('matches sub-sample ids', () => {
    expect(worksheetMatchesSampleQuery(ws(['P-0144-S03']), 'S03')).toBe(true)
    expect(worksheetMatchesSampleQuery(ws(['P-0144-S03']), 's03')).toBe(true)
  })
})

describe('findWorksheetForSample', () => {
  const sheets = [
    ws(['P-0100', 'P-0101'], 10, 'WS-10'),
    ws(['P-0144', 'P-0144-S03'], 20, 'WS-20'),
  ]

  it('finds the worksheet containing a parent sample id', () => {
    expect(findWorksheetForSample(sheets, 'P-0144')?.id).toBe(20)
  })

  it('finds the worksheet containing a sub-sample id', () => {
    expect(findWorksheetForSample(sheets, 'P-0144-S03')?.id).toBe(20)
  })

  it('returns undefined when no worksheet has the sample', () => {
    expect(findWorksheetForSample(sheets, 'P-9999')).toBeUndefined()
  })

  it('returns undefined for a falsy id', () => {
    expect(findWorksheetForSample(sheets, null)).toBeUndefined()
    expect(findWorksheetForSample(sheets, undefined)).toBeUndefined()
    expect(findWorksheetForSample(sheets, '')).toBeUndefined()
  })
})
