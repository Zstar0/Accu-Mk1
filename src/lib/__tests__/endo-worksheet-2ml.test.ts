import { describe, it, expect } from 'vitest'
import type {
  ConsumableType,
  EndoMethodInfo,
  WorksheetListItem,
} from '@/lib/api'
import {
  ENDO_RUN_PARAM_DEFAULTS,
  formOf,
  type EndoCheck,
  type EndoSample,
} from '@/lib/endo-prep-2ml'
import {
  allowedCartridges,
  cartridgeNote,
  endoCtxFor,
  endoRowsFor,
  endoSampleFor,
  runParamsFrom,
  totalGroupKey,
  type WorksheetItemRow,
} from '@/lib/endo-worksheet-2ml'

const METHOD: EndoMethodInfo = {
  id: 9,
  name: 'Endotoxin',
  revision: 3,
  status: 'active',
  run_parameters: { endotoxin: { std_total_dilution: 300 } },
  cartridges: [
    {
      id: 1,
      name: 'Endosafe 0.05',
      sensitivity_eu_ml: 0.05,
      is_default: true,
      active: true,
    },
    {
      id: 2,
      name: 'Endosafe 0.01',
      sensitivity_eu_ml: 0.01,
      is_default: false,
      active: true,
    },
    {
      id: 4,
      name: 'Endosafe old',
      sensitivity_eu_ml: 0.02,
      is_default: false,
      active: false,
    },
  ],
}

function ws(over: Partial<WorksheetListItem> = {}): WorksheetListItem {
  return {
    id: 1,
    title: 'Endo 10/10/2026',
    status: 'open',
    items: [],
    endo_prep: '2ml',
    endo_method: METHOD,
    cartridge_type_id: null,
    cartridge_sensitivity_eu_ml: null,
    ...over,
  } as WorksheetListItem
}

function item(over: Partial<WorksheetItemRow> = {}): WorksheetItemRow {
  return {
    id: 10,
    sample_id: 'P-0001-S01',
    analyses: [],
    assignment_role: 'endo',
    sample_identity: 'BPC-157',
    declared_weight_mg: 10,
    ...over,
  } as WorksheetItemRow
}

const catalogType = (
  id: number,
  sensitivity: number,
  over: Partial<ConsumableType> = {}
): ConsumableType => ({
  id,
  kind: 'endo_cartridge',
  name: `Endosafe ${sensitivity}`,
  manufacturer: null,
  part_number: null,
  instrument_id: null,
  specs: { sensitivity_eu_ml: sensitivity },
  active: true,
  in_use: false,
  ...over,
})

describe('runParamsFrom', () => {
  it("falls back to Dennis's values with no method", () => {
    expect(runParamsFrom(null)).toEqual(ENDO_RUN_PARAM_DEFAULTS)
  })

  it('takes the keys the method sets and nothing else', () => {
    expect(runParamsFrom(METHOD)).toEqual({
      ...ENDO_RUN_PARAM_DEFAULTS,
      stdTotalDilution: 300,
    })
  })
})

describe('allowed cartridges', () => {
  it("are the method's active ones, least sensitive first", () => {
    expect(allowedCartridges(ws()).map(c => c.id)).toEqual([1, 2])
    expect(endoCtxFor(ws()).allowedLambdas).toEqual([0.05, 0.01])
  })

  it('with no method, are the active endo cartridges in the catalog', () => {
    const catalog = [
      catalogType(2, 0.01),
      catalogType(1, 0.05),
      catalogType(5, 0.1, { active: false }),
      catalogType(6, 0.5, { kind: 'pipette_tip' }),
    ]
    const noMethod = ws({ endo_method: null })
    expect(allowedCartridges(noMethod, catalog).map(c => c.id)).toEqual([1, 2])
    expect(endoCtxFor(noMethod, catalog).params).toEqual(
      ENDO_RUN_PARAM_DEFAULTS
    )
  })

  it('a method that links no cartridges allows the catalog, with no default', () => {
    const catalog = [catalogType(2, 0.01), catalogType(1, 0.05)]
    const bare = ws({ endo_method: { ...METHOD, cartridges: [] } })
    expect(
      allowedCartridges(bare, catalog).map(c => [c.id, c.is_default])
    ).toEqual([
      [1, false],
      [2, false],
    ])
    expect(endoCtxFor(bare, catalog).params.stdTotalDilution).toBe(300)
  })

  it('a method that links only retired cartridges allows none, not the catalog', () => {
    const catalog = [catalogType(2, 0.01), catalogType(1, 0.05)]
    const retiredOnly = ws({
      endo_method: {
        ...METHOD,
        cartridges: METHOD.cartridges.filter(c => !c.active),
      },
    })
    expect(allowedCartridges(retiredOnly, catalog)).toEqual([])
    expect(endoCtxFor(retiredOnly, catalog).allowedLambdas).toEqual([])
  })
})

describe('endoSampleFor', () => {
  it('leaves the form to the maths: bac water by Sample ID, else powder; prep_form wins', () => {
    expect(formOf(endoSampleFor(item({ sample_id: 'BW-0101' }), ws()))).toBe(
      'bac'
    )
    expect(formOf(endoSampleFor(item(), ws()))).toBe('powder')
    expect(
      formOf(
        endoSampleFor(item({ sample_id: 'BW-0101', prep_form: 'liquid' }), ws())
      )
    ).toBe('liquid')
  })

  it('a row takes the method default; bac water takes the allowed 0.01', () => {
    expect(endoSampleFor(item(), ws()).lambda).toBe(0.05)
    expect(endoSampleFor(item({ sample_id: 'BW-0101' }), ws()).lambda).toBe(
      0.01
    )
  })

  it('bac water with no 0.01 allowed falls back to the run cartridge', () => {
    const only05 = {
      ...METHOD,
      cartridges: METHOD.cartridges.filter(c => c.id === 1),
    }
    expect(
      endoSampleFor(item({ sample_id: 'BW-0101' }), ws({ endo_method: only05 }))
        .lambda
    ).toBe(0.05)
  })

  it("the run's own pick beats the method default", () => {
    expect(
      endoSampleFor(
        item(),
        ws({ cartridge_type_id: 2, cartridge_sensitivity_eu_ml: 0.01 })
      ).lambda
    ).toBe(0.01)
  })

  it('a retired cartridge on a row keeps its serialized sensitivity', () => {
    expect(
      endoSampleFor(
        item({ cartridge_type_id: 4, cartridge_sensitivity_eu_ml: 0.02 }),
        ws()
      ).lambda
    ).toBe(0.02)
  })

  it('no cartridge at all leaves lambda empty, so results do not compute', () => {
    expect(endoSampleFor(item(), ws({ endo_method: null })).lambda).toBeNull()
  })

  it('reads the weight override, the 2 mL inputs, the reading and the stored steps', () => {
    const s = endoSampleFor(
      item({
        prep_weight_mg: 12,
        prep_water_ml: 1.5,
        prep_total_dilution: 500,
        prep_steps: [[25, 8], null, [100]],
        result_reading: '<0.05',
      }),
      ws()
    )
    expect(s).toMatchObject({
      weightMg: 12,
      waterMl: 1.5,
      totalDilution: 500,
      reading: '<0.05',
      steps: [{ sampleUl: 25, ratio: 8 }, null, { sampleUl: 100 }],
    })
  })
})

describe('endoRowsFor', () => {
  it("bac water prefers the row's own 0.01 when two allowed types share it", () => {
    const twin01 = {
      ...METHOD,
      cartridges: [
        ...METHOD.cartridges,
        {
          id: 5,
          name: 'Endosafe 0.01 (second make)',
          sensitivity_eu_ml: 0.01,
          is_default: false,
          active: true,
        },
      ],
    }
    const rows = endoRowsFor(
      [
        item({
          id: 11,
          sample_id: 'BW-0101',
          cartridge_type_id: 5,
          cartridge_sensitivity_eu_ml: 0.01,
        }),
        item({ id: 12, sample_id: 'BW-0102' }),
      ],
      ws({ endo_method: twin01 })
    )
    expect(rows.map(r => [r.cartridge?.id, r.inherited?.id])).toEqual([
      [5, 5],
      [2, 2],
    ])
  })

  it('numbers rows in the order given and carries the cartridge a reading saves with', () => {
    const rows = endoRowsFor(
      [item({ id: 11, sample_id: 'BW-0101' }), item({ id: 10 })],
      ws()
    )
    expect(
      rows.map(r => [r.n, r.item.id, r.cartridge?.id, r.inherited?.id])
    ).toEqual([
      [1, 11, 2, 2],
      [2, 10, 1, 1],
    ])
  })
})

describe('cartridgeNote', () => {
  const check = (over: Partial<EndoCheck>): EndoCheck => ({
    lambda: null,
    water: null,
    dilution: null,
    loaded: null,
    mvd: null,
    mvc: null,
    valid: null,
    needs: null,
    floorShown: null,
    floorVial: null,
    failAt: null,
    lod: null,
    loqVial: null,
    loqMl: null,
    ...over,
  })

  it('says nothing when the prep reads the limit or has no cartridge', () => {
    expect(
      cartridgeNote(check({ lambda: 0.05, valid: true }), false)
    ).toBeNull()
    expect(cartridgeNote(check({ valid: false }), false)).toBeNull()
  })

  it("names the loaded concentration, the MVC and the cartridge it needs, as Dennis's sheet does", () => {
    expect(
      cartridgeNote(
        check({
          lambda: 0.05,
          valid: false,
          loaded: 0.0005,
          mvc: 0.14,
          needs: 0.005,
        }),
        false
      )
    ).toEqual({
      text: '0.0005 mg/mL loaded < MVC 0.14 · needs 0.005',
      tone: 'warn',
    })
    expect(
      cartridgeNote(
        check({ lambda: 0.005, valid: false, loaded: 0.0005, mvc: 0.014 }),
        false
      )
    ).toEqual({
      text: '0.0005 mg/mL loaded < MVC 0.014 · no valid cartridge',
      tone: 'crit',
    })
    expect(
      cartridgeNote(check({ lambda: 0.05, valid: false, floorShown: 1 }), true)
    ).toEqual({ text: 'floor 1 > 0.25 limit', tone: 'crit' })
  })
})

describe('totalGroupKey', () => {
  const ctx = { params: ENDO_RUN_PARAM_DEFAULTS, allowedLambdas: [] }
  const row = (o: Partial<EndoSample>): EndoSample => ({
    sampleId: 'P-1',
    identity: 'Examplerelin',
    sampleType: null,
    weightMg: 10,
    form: null,
    waterMl: null,
    totalDilution: null,
    steps: null,
    lambda: null,
    reading: null,
    reader: null,
    ...o,
  })

  it('is the target as shown, whatever r6 leaves in the product of the steps', () => {
    // 1:15 at 1:250 makes 249.99999; 1:999 at 1:3000 makes 3000.000996
    expect(
      totalGroupKey(
        row({ steps: [{ sampleUl: 20, ratio: 15 }, null, null] }),
        ctx
      )
    ).toBe('250')
    expect(
      totalGroupKey(
        row({
          totalDilution: 3000,
          steps: [{ sampleUl: 20, ratio: 999 }, null, null],
        }),
        ctx
      )
    ).toBe('3000')
    expect(totalGroupKey(row({ totalDilution: 15 }), ctx)).toBe('x')
    expect(totalGroupKey(row({ sampleId: 'BW-1' }), ctx)).toBe('bac')
  })
})
