import { describe, expect, it } from 'vitest'
import {
  ENDOSCAN_FIELDS,
  blendNickname,
  endoscanCsvField,
  endoscanFamily,
  endoscanSampleCsv,
  endoscanSampleRows,
} from '@/lib/endo-reader-export'
import { parseEndoScan } from '@/lib/endo-reader'
import {
  ENDO_RUN_PARAM_DEFAULTS,
  type EndoCtx,
  type EndoSample,
} from '@/lib/endo-prep-2ml'
import type { EndoPrepRule } from '@/lib/endo-prep-rules'

/**
 * Ported from Dennis's calc.test.js (tools-dennis @ ab866a2): the four export
 * cases, with his expected values kept exactly as he wrote them so a change on
 * either side shows up here.
 */
const ctx: EndoCtx = {
  params: ENDO_RUN_PARAM_DEFAULTS,
  allowedLambdas: [0.05, 0.01, 0.005],
}

function sample(o: Partial<EndoSample> = {}): EndoSample {
  return {
    sampleId: 'P-1',
    identity: 'Examplerelin',
    sampleType: null,
    weightMg: null,
    form: null,
    waterMl: null,
    totalDilution: null,
    steps: null,
    lambda: 0.05,
    reading: null,
    reader: null,
    ...o,
  }
}

/** A trial rule fixing the total, as Dennis's `rules` argument does. */
function rule(total: number): EndoPrepRule {
  return {
    id: 1,
    peptide_id: 1,
    min_mg: null,
    max_mg: null,
    total_dilution: total,
    step1_ratio: null,
    cartridge_type_id: null,
    status: 'trial',
    note: null,
    sort_order: 0,
    active: true,
  }
}

describe('EndoScan-V sample export', () => {
  it('writes one row per vial, factor 1:1, the limit as the MCS reading', () => {
    const samples = [
      sample({ sampleId: 'P-5299-S02', identity: 'Semaglutide', weightMg: 10 }),
      // 1:300 by rule
      sample({
        sampleId: 'P-5300-S02',
        identity: 'Tesamorelin',
        weightMg: 10,
        rule: rule(300),
      }),
      sample({
        sampleId: 'P-5301-S02',
        identity: 'Retatrutide',
        weightMg: 10,
        form: 'liquid',
        waterMl: 3,
      }),
      sample({ sampleId: 'BW-0010-S01', identity: 'Bacteriostatic Water', form: 'bac' }),
      // no ID: skipped
      sample({ sampleId: '', identity: 'MOTS-c', weightMg: 10 }),
      // no volume: skipped
      sample({ sampleId: 'P-5302-S02', identity: 'GHK-Cu', weightMg: 10, form: 'liquid' }),
      // cannot be made: skipped
      sample({
        sampleId: 'P-5303-S02',
        identity: 'Sermorelin',
        weightMg: 10,
        totalDilution: 15,
      }),
    ]
    const { rows, skipped } = endoscanSampleRows(samples, ctx)

    expect(rows.map(r => r['Sample Name'])).toEqual([
      'P-5299-S02',
      'P-5300-S02',
      'P-5301-S02',
      'BW-0010-S01',
    ])
    expect(rows.map(r => r['Sample ID'])).toEqual([
      'Semaglutide',
      'Tesamorelin',
      'Retatrutide',
      'Bacteriostatic Water',
    ])
    expect(skipped.map(x => x.why)).toEqual([
      'no Sample ID',
      'a liquid vial with no volume typed',
      'the dilution cannot be made as typed',
    ])

    // The reader shows the vial; the Sample ID says the peptide.
    const a = rows[0]!
    expect(a['Product Family']).toBe('Peptides')
    expect(a['Dil./Conc.']).toBe('1:1')
    expect(a.Units).toBe('mL/mL')
    expect(a['Max. Dosage']).toBe('0')
    expect(a['Auto Spike']).toBe('Yes')
    expect(a['Performed With']).toBe('LAL')
    expect(a['EU Criteria']).toBe('≤')
    expect(a['Endotoxin Limit']).toBe('0.7') // 350 / (2 mL x 250)
    expect(a.Comments).toBe('1:250 in 2 mL')

    expect(rows[1]!['Endotoxin Limit']).toBe('0.583') // 350 / (2 x 300)
    expect(rows[1]!.Comments).toBe('1:300 in 2 mL')

    // A liquid vial's own water.
    expect(rows[2]!.Comments).toBe('1:250 in 3 mL')
    expect(rows[2]!['Endotoxin Limit']).toBe('0.467') // 350 / (3 x 250)

    const bw = rows[3]!
    expect(bw['Dil./Conc.']).toBe('1:20')
    expect(bw['Endotoxin Limit']).toBe('0.25')
    expect(bw.Comments).toBe('50 + 950 uL LAL water')
    expect(bw['Product Family']).toBe('Bacteriostatic Water')
  })

  it('writes the file with a BOM, CRLF and no micro sign', () => {
    const samples = [
      sample({ sampleId: 'P-5300-S02', identity: 'Tesamorelin', weightMg: 10, rule: rule(300) }),
    ]
    const { csv, count } = endoscanSampleCsv(samples, ctx)
    expect(count).toBe(1)
    expect(csv.startsWith('﻿' + ENDOSCAN_FIELDS.join(',') + '\r\n')).toBe(true)
    expect(csv.split('\r\n').filter(Boolean).length).toBe(2)
    expect(/[µμ]/.test(csv)).toBe(false)
    // The 13 columns EndoScan-V reads, by position.
    expect(ENDOSCAN_FIELDS.join(',')).toBe(
      'Product Family,Sample Name,Sample ID,Max. Dosage,Units,Dil./Conc.,Endotoxin Limit,' +
        'EU Criteria,Alert Limit,Auto Spike,Spike Conc.,Performed With,Comments'
    )
    expect(
      csv.indexOf(
        'Peptides,P-5300-S02,Tesamorelin,0,mL/mL,1:1,0.583,' +
          String.fromCharCode(0x2264) +
          ',,Yes,,LAL,1:300 in 2 mL'
      )
    ).toBeGreaterThan(0)
  })

  it('turns a comma inside a product into " + ", since the importer ignores quotes', () => {
    const { csv } = endoscanSampleCsv(
      [sample({ sampleId: 'PB-1', identity: 'BPC-157, TB500', weightMg: 10 })],
      ctx
    )
    expect(csv.indexOf('Peptides,PB-1,BPC-157 + TB500,0,')).toBeGreaterThan(0)
    expect(endoscanCsvField('BPC-157, TB500')).toBe('BPC-157 + TB500')
    expect(endoscanCsvField('a "quoted" one')).toBe('a  quoted  one')
  })

  it('defuses a field that would read as a formula in a spreadsheet', () => {
    expect(endoscanCsvField('=cmd()')).toBe("'=cmd()")
    expect(endoscanCsvField('@SUM(A1)')).toBe("'@SUM(A1)")
    // Never on a real row: the apostrophe would otherwise reach the reader.
    expect(endoscanCsvField('Semaglutide')).toBe('Semaglutide')
    expect(endoscanCsvField('0.583')).toBe('0.583')
    expect(endoscanCsvField('1:250 in 2 mL')).toBe('1:250 in 2 mL')
  })

  it('cuts the Sample ID to 40 characters at a word, keeping the Sample Name whole', () => {
    const long = 'KPV + GHK-Cu + BPC-157 + TB500 (Thymosin Beta 4)' // 48
    expect(endoscanFamily(long)).toBe('KPV + GHK-Cu + BPC-157 + TB500')
    // 32: untouched
    expect(endoscanFamily('BPC-157 + TB500 (17-23 Fragment)')).toBe(
      'BPC-157 + TB500 (17-23 Fragment)'
    )
    // 41: cut at a word, never left on an open bracket
    expect(endoscanFamily('GHK-Cu + BPC-157 + TB500 (17-23 Fragment)')).toBe(
      'GHK-Cu + BPC-157 + TB500'
    )
    expect(endoscanFamily('A'.repeat(60)).length).toBeLessThanOrEqual(40)

    // A long blend with no nickname: the Sample ID is cut, the name kept.
    const long2 = 'Semaglutide + Tirzepatide + Retatrutide + Tesamorelin' // 53
    const row = endoscanSampleRows(
      [sample({ sampleId: 'PB-9999-S02', identity: long2, weightMg: 80 })],
      ctx
    ).rows[0]!
    expect(row['Product Family']).toBe('Peptides')
    expect(row['Sample Name']).toBe('PB-9999-S02')
    expect(row['Sample ID']).toBe('Semaglutide + Tirzepatide + Retatrutide')

    expect(
      endoscanSampleRows(
        [
          sample({
            sampleId: 'PB-1069-S02',
            identity: 'Retatrutide, Tirzepatide, CJC-1295 (no DAC)',
            weightMg: 10,
          }),
        ],
        ctx
      ).rows[0]!['Sample ID']
    ).toBe('Retatrutide, Tirzepatide, CJC-1295')
  })

  it('names KLOW and GLOW by their components, ignoring descriptors and order', () => {
    expect(blendNickname('KPV + GHK-Cu + BPC-157 + TB500 (Thymosin Beta 4)')).toBe('KLOW')
    expect(blendNickname('GHK-Cu + BPC-157 + TB500 (17-23 Fragment)')).toBe('GLOW')
    expect(blendNickname('GHK-Cu, BPC-157, TB500')).toBe('GLOW')
    expect(blendNickname('TB500 + BPC-157 + GHK-Cu')).toBe('GLOW')
    // Two of the three: not GLOW.
    expect(blendNickname('BPC-157 + TB500')).toBeNull()
    expect(blendNickname('KPV + GHK-Cu + BPC-157 + TB500 + NAD+')).toBeNull()
    expect(blendNickname('Retatrutide')).toBeNull()

    const rows = endoscanSampleRows(
      [
        sample({
          sampleId: 'PB-1079-S02',
          identity: 'KPV + GHK-Cu + BPC-157 + TB500 (Thymosin Beta 4)',
          weightMg: 80,
        }),
        sample({
          sampleId: 'PB-1076-S02',
          identity: 'GHK-Cu + BPC-157 + TB500 (17-23 Fragment)',
          weightMg: 70,
        }),
        sample({ sampleId: 'PB-0544-S02', identity: 'BPC-157, TB500', weightMg: 10 }),
      ],
      ctx
    ).rows
    expect(rows.map(r => r['Sample ID'])).toEqual(['KLOW', 'GLOW', 'BPC-157, TB500'])
  })

  it('writes each vial ID once, naming the row it leaves out', () => {
    const { rows, skipped } = endoscanSampleRows(
      [
        sample({ sampleId: 'P-5367-S02', identity: 'Tirzepatide', weightMg: 10 }),
        // A retest row added by hand.
        sample({ sampleId: 'p-5367-s02', identity: 'Tirzepatide', weightMg: 10 }),
        sample({ sampleId: 'P-5368-S02', identity: 'Tirzepatide', weightMg: 10 }),
      ],
      ctx
    )
    expect(rows.map(r => r['Sample Name'])).toEqual(['P-5367-S02', 'P-5368-S02'])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.sampleId).toBe('p-5367-s02')
    expect(skipped[0]!.why).toMatch(/already in the file/)
  })

  /**
   * The contract this file creates: a vial set up by our export has to come
   * back through our own import on its own row. The reader carries the three
   * free-text fields across unchanged, so the export's Sample Name (the vial)
   * and Sample ID (the peptide) are what `idFields` sees.
   */
  it('round-trips: a vial exported here is matched by the reader import', () => {
    const samples = [
      sample({ sampleId: 'P-5299-S02', identity: 'Semaglutide', weightMg: 10 }),
      sample({ sampleId: 'BW-0010-S01', identity: 'Bacteriostatic Water', form: 'bac' }),
      sample({
        sampleId: 'PB-1079-S02',
        identity: 'KPV + GHK-Cu + BPC-157 + TB500 (Thymosin Beta 4)',
        weightMg: 80,
      }),
    ]
    const { rows } = endoscanSampleRows(samples, ctx)

    // The reader's results file, with each exported row's own Sample Name and
    // Sample ID in the operator fields (the "1014" layout: the vial first).
    const readerRow = (r: (typeof rows)[number], kind: 'SPL1' | 'SPK1', tid: string) => {
      const c = new Array<string>(79).fill('')
      c[0] = '1'
      c[10] = kind
      c[11] = r['Sample Name']
      c[12] = r['Sample ID']
      c[13] = 'short'
      c[22] = '0.0'
      c[24] = '25'
      if (kind === 'SPK1') {
        c[6] = '50'
        c[7] = '200'
        c[16] = '0.8'
        c[18] = '100'
        c[27] = '0.8'
        c[29] = '1'
      } else {
        c[16] = '1'
        c[26] = '<'
        c[27] = '0.05'
        c[28] = '1'
      }
      c[31] = '5-0.05'
      c[44] = '1111111111'
      c[73] = tid
      return c.join(',')
    }
    const file = rows
      .flatMap((r, i) => [readerRow(r, 'SPL1', `T-${i}`), readerRow(r, 'SPK1', `T-${i}`)])
      .join('\n')

    const { tests } = parseEndoScan(file)
    expect(tests.map(t => t.sampleId)).toEqual([
      'P-5299-S02',
      'BW-0010-S01',
      'PB-1079-S02',
    ])
    // The peptide rides along as the identity, the blend under its nickname.
    expect(tests.map(t => t.identity)).toEqual([
      'Semaglutide',
      'Bacteriostatic Water',
      'KLOW',
    ])
  })

  it('cuts the assay label off an identity the inbox stored with one', () => {
    const row = endoscanSampleRows(
      [
        sample({
          sampleId: 'P-5400-S02',
          identity: 'Retatrutide - Identity (HPLC)',
          weightMg: 10,
        }),
      ],
      ctx
    ).rows[0]!
    expect(row['Sample ID']).toBe('Retatrutide')
  })
})
