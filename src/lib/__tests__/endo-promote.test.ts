import { describe, it, expect, vi, afterEach } from 'vitest'
import { promoteWorksheetRows, type WorksheetListItem } from '@/lib/api'
import type { EndoReaderRecord } from '@/lib/endo-prep-2ml'
import { promoteCheck } from '@/lib/endo-promote'
import { endoCtxFor, endoRowsFor } from '@/lib/endo-worksheet-2ml'
import type { WorksheetItemRow } from '@/lib/endo-worksheet'
import {
  endoItem,
  endoWorksheet,
} from '@/components/hplc/endo/__tests__/endo-fixtures'

/** The vial's live native endotoxin analysis, as Task 5 serializes it. */
const NATIVE = {
  id: 501,
  state: 'to_be_verified',
  keyword: 'ENDOTOXIN-USP85LAL',
  native: true,
}

const BAC = {
  sample_id: 'BW-0001',
  sample_type: 'Bacteriostatic Water',
  sample_identity: 'Bacteriostatic Water',
}

// A made-up reader record that failed spike recovery; never a real result.
const INVALID: EndoReaderRecord = {
  test_id: 'T-9',
  result: '<0.05',
  reader: 'MCS-1234',
  slot: 2,
  operator: 'QA',
  tested_at: '2026-10-09 14:02',
  temp_start: 37,
  temp_end: 37.1,
  software: '1.0',
  cartridge_lot: 'L1',
  cartridge_expiry: '2027-01-31',
  cartridge_range: '5 - 0.05',
  spike_level: 0.8,
  recovery: 44,
  rec_min: 50,
  rec_max: 200,
  sample_cv: 3.1,
  spike_cv: 3.7,
  cv_limit: 25,
  reader_pass: false,
  valid: false,
  why: ['spike recovery 44 % outside 50-200 %'],
  file_name: 'EndoScanV-Export-2026-10-09.csv',
}

/** One row on the fixture's 2 mL worksheet (run cartridge 0.05, method
 *  allowing 0.05 and 0.01, 1:250 into 2 mL), checked. */
function check(
  over: Partial<WorksheetItemRow>,
  ws: Partial<WorksheetListItem> = {}
) {
  const item = endoItem({ endo_analysis: NATIVE, ...over })
  const worksheet = endoWorksheet([item], ws)
  const [row] = endoRowsFor([item], worksheet)
  if (!row) throw new Error('no row')
  return {
    item,
    result: promoteCheck(row, endoCtxFor(worksheet), worksheet.endo_prep),
  }
}

describe('promoteCheck: what an eligible row sends', () => {
  it('a peptide "<" result sends its LOQ as its value, in EU/vial, with the cartridge as LOD', () => {
    // <0.05 x 250 x 2 mL = <25 EU/vial: stored as 25 with LOQ 25 (D3)
    const { item, result } = check({ result_reading: '<0.05' })
    expect(result).toEqual({
      eligible: true,
      payload: {
        item_id: item.id,
        value: 25,
        unit: 'EU/vial',
        loq: 25,
        lod: 0.05,
        lod_unit: 'EU/mL',
      },
    })
  })

  it('an exact peptide reading sends its EU/vial and the prep LOQ, Pass or Fail alike', () => {
    expect(check({ result_reading: '0.08' }).result).toMatchObject({
      eligible: true,
      payload: { value: 40, unit: 'EU/vial', loq: 25, lod: 0.05 },
    })
    // 0.8 x 250 x 2 = 400 > 350: a Fail is promoted too
    expect(check({ result_reading: '0.8' }).result).toMatchObject({
      eligible: true,
      payload: { value: 400, unit: 'EU/vial', loq: 25 },
    })
  })

  it('bac water sends the reading itself in EU/mL; its "<" floor is the 0.01 cartridge x 20', () => {
    // the reading is EU/mL of the water with its 20x applied: <0.2 on the 0.01
    const { item, result } = check({ ...BAC, result_reading: '<0.2' })
    expect(result).toEqual({
      eligible: true,
      payload: {
        item_id: item.id,
        value: 0.2,
        unit: 'EU/mL',
        loq: 0.2,
        lod: 0.01,
        lod_unit: 'EU/mL',
      },
    })
    expect(check({ ...BAC, result_reading: '0.1' }).result).toMatchObject({
      eligible: true,
      payload: { value: 0.1, unit: 'EU/mL', loq: 0.2, lod: 0.01 },
    })
  })

  it('a ">" that already fails sends the floor with result_floor', () => {
    // >5 x 250 x 2 = at least 2500 EU/vial, past the 350 limit: a definitive
    // failure whatever the true value is, so it reports. The LOQ stays the
    // run's 25, unlike a "<" where the value and the LOQ are one number.
    const { item, result } = check({ result_reading: '>5' })
    expect(result).toEqual({
      eligible: true,
      payload: {
        item_id: item.id,
        value: 2500,
        unit: 'EU/vial',
        loq: 25,
        lod: 0.05,
        lod_unit: 'EU/mL',
        result_floor: true,
      },
    })
    // exactly at the limit still fails: "at least 350" is not a pass
    expect(check({ result_reading: '>0.7' }).result).toMatchObject({
      eligible: true,
      payload: { value: 350, result_floor: true },
    })
  })

  it('sends a "<" value and its LOQ as one number, and the LOD unrounded', () => {
    // a row's own 0.0025 cartridge: Box 3's 3 decimals would make it 0.003
    const { result } = check({
      result_reading: '<0.0025',
      cartridge_type_id: 9,
      cartridge_sensitivity_eu_ml: 0.0025,
    })
    if (!('eligible' in result) || !result.eligible)
      throw new Error('expected an eligible row')
    expect(result.payload.loq).toBe(result.payload.value)
    expect(result.payload.lod).toBe(0.0025)
  })

  it('a promoted vial result is a chip, not a checkbox', () => {
    expect(
      check({
        result_reading: '<0.05',
        endo_analysis: { ...NATIVE, state: 'promoted' },
      }).result
    ).toEqual({ promoted: true })
  })
})

describe("promoteCheck: refusals, in spec 5.2's order, with the server's reasons", () => {
  const reasonOf = (
    over: Partial<WorksheetItemRow>,
    ws: Partial<WorksheetListItem> = {}
  ) => {
    const { result } = check(over, ws)
    return 'reason' in result ? result.reason : null
  }

  it('a stock worksheet', () => {
    expect(reasonOf({ result_reading: '<0.05' }, { endo_prep: 'stock' })).toBe(
      'promote is for 2 mL worksheets'
    )
  })

  it('no live endotoxin analysis on the vial (null, or a server that sends none)', () => {
    expect(reasonOf({ result_reading: '<0.05', endo_analysis: null })).toBe(
      'the vial has no endotoxin analysis'
    )
    expect(
      reasonOf({ result_reading: '<0.05', endo_analysis: undefined })
    ).toBe('the vial has no endotoxin analysis')
  })

  it('a SENAITE-born endotoxin analysis, before anything else about the row', () => {
    expect(
      reasonOf({
        result_reading: null,
        endo_analysis: { ...NATIVE, keyword: 'ENDO-LAL', native: false },
      })
    ).toBe('manual entry: SENAITE-born endotoxin')
  })

  it('a vial result past the open states', () => {
    expect(
      reasonOf({
        result_reading: '<0.05',
        endo_analysis: { ...NATIVE, state: 'verified' },
      })
    ).toBe("the vial's endotoxin analysis is verified")
  })

  it('no reading', () => {
    expect(reasonOf({ result_reading: null })).toBe('no reading')
  })

  it("an Invalid reader test, with the record's reasons", () => {
    expect(reasonOf({ result_reading: '<0.05', result_reader: INVALID })).toBe(
      'Invalid: spike recovery 44 % outside 50-200 %'
    )
  })

  it('an inconclusive "<", before its floor is checked', () => {
    // <1 x 250 x 2 = <500 EU/vial: its LOQ 500 is above 350 (it is also off the 0.05 floor)
    expect(reasonOf({ result_reading: '<1' })).toBe(
      'inconclusive: LOQ 500 EU/vial is above the 350 limit'
    )
  })

  it('an inconclusive ">": the floor does not reach the limit', () => {
    // >0.5 x 250 x 2 = 250, under 350: the true value could be either side
    expect(reasonOf({ result_reading: '>0.5' })).toBe(
      'inconclusive: a floor of 250 EU/vial does not reach the 350 limit; ' +
        "a '>' reading reports only when the floor itself already fails, so " +
        're-run the vial at a higher dilution for a number'
    )
  })

  it('a "<" reading that is not the cartridge\'s floor', () => {
    // <0.1 x 250 x 2 = <50: a pass, but the stored 50 would not be its LOQ
    expect(reasonOf({ result_reading: '<0.1' })).toBe(
      "the reading <0.1 is not this cartridge's sensitivity (0.05)"
    )
  })

  it('a bac water "<" off the cartridge x 20 floor, and an inconclusive one, in EU/mL', () => {
    // typed with its 20x applied: the 0.01 cartridge's floor is <0.2, not <0.1
    expect(reasonOf({ ...BAC, result_reading: '<0.1' })).toBe(
      "the reading <0.1 is not this cartridge's floor for bac water (0.2)"
    )
    expect(reasonOf({ ...BAC, result_reading: '<0.3' })).toBe(
      'inconclusive: LOQ 0.3 EU/mL is above the 0.25 limit'
    )
  })

  it("a form that disagrees with the sample's bac water rule", () => {
    expect(reasonOf({ result_reading: '0.1', prep_form: 'bac' })).toBe(
      'peptides promote in EU/vial'
    )
    expect(
      reasonOf({ ...BAC, result_reading: '0.08', prep_form: 'powder' })
    ).toBe('bac water promotes in EU/mL')
  })

  it('a reading with no EU value (a liquid vial with no water typed)', () => {
    expect(reasonOf({ result_reading: '0.08', prep_form: 'liquid' })).toBe(
      'the value, LOQ or LOD does not match the worksheet row'
    )
  })
})

describe('promoteWorksheetRows', () => {
  afterEach(() => vi.unstubAllGlobals())

  const row = {
    item_id: 7,
    value: 25,
    unit: 'EU/vial',
    loq: 25,
    lod: 0.05,
    lod_unit: 'EU/mL',
  }

  it('POSTs the rows to the worksheet and returns the per-row results', async () => {
    const results = [
      {
        item_id: 7,
        promoted: true,
        parent_analysis_id: 9001,
        state: 'parent_to_verify',
      },
    ]
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results }),
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(promoteWorksheetRows(77, [row])).resolves.toEqual({ results })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/worksheets\/77\/promote$/)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ rows: [row] })
  })

  it("throws the server's detail on a 400", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ detail: 'item 7 is listed twice' }),
      })
    )
    await expect(promoteWorksheetRows(77, [row, row])).rejects.toThrow(
      'item 7 is listed twice'
    )
  })
})
