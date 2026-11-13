import { describe, expect, it } from 'vitest'
import { buildEndoSheet2Doc } from '@/lib/endo-bench-sheet-2ml'
import { endoscanSampleCsv, endoscanSampleRows } from '@/lib/endo-reader-export'
import {
  endoItem,
  endoWorksheet,
} from '@/components/hplc/endo/__tests__/endo-fixtures'

/**
 * The path the Reader CSV button actually takes: the worksheet the page holds,
 * through the same doc the bench sheet prints, into the export. The unit tests
 * build EndoSamples by hand, so this is the one that would catch a field the
 * doc fills differently.
 */
const opts = {
  analystName: 'Test Analyst',
  calendar: null,
  printedAt: 'now',
  dueAtByItemId: new Map<number, string | null>(),
}

describe('the Reader CSV, built the way the button builds it', () => {
  it('writes a run that has no cartridge picked yet', () => {
    // The file is made before the run, so no row and no worksheet need carry a
    // cartridge. The limit comes from the weight and the total, not the
    // cartridge, so every row must still be written.
    const doc = buildEndoSheet2Doc(
      endoWorksheet([
        endoItem({ sample_id: 'P-0101-S02', sample_identity: 'Semaglutide' }),
        endoItem({
          sample_id: 'BW-0114-S02',
          sample_identity: 'Bacteriostatic Water',
          sample_type: 'Bacteriostatic Water',
        }),
      ]),
      opts
    )
    // Stripped to the state before anyone picks a cartridge, which is when
    // this file is made.
    const { rows, skipped } = endoscanSampleRows(
      doc.rows.map(r => ({ ...r.sample, lambda: null })),
      doc.ctx
    )
    expect(skipped).toEqual([])
    expect(rows.map(r => [r['Sample Name'], r['Endotoxin Limit']])).toEqual([
      ['P-0101-S02', '0.7'],
      ['BW-0114-S02', '0.25'],
    ])
  })

  it('names a blend whose parts each carry their own assay label', () => {
    // Mk1's inbox can store an identity with the label repeated per part. The
    // nickname is matched on the parts with brackets dropped, so it still
    // fires, and the Sample ID stays inside the reader's 40 characters.
    const doc = buildEndoSheet2Doc(
      endoWorksheet([
        endoItem({
          sample_id: 'PB-1079-S02',
          sample_identity:
            'KPV (Identity), GHK-Cu (Identity), BPC-157 (Identity), TB500 (Identity)',
          declared_weight_mg: 80,
        }),
      ]),
      opts
    )
    const row = endoscanSampleRows(
      doc.rows.map(r => r.sample),
      doc.ctx
    ).rows[0]
    expect(row?.['Sample ID']).toBe('KLOW')
    expect((row?.['Sample ID'] ?? '').length).toBeLessThanOrEqual(40)
  })

  it('keeps every Sample ID inside the reader s 40 characters', () => {
    const doc = buildEndoSheet2Doc(
      endoWorksheet([
        endoItem({
          sample_id: 'PB-2000-S02',
          sample_identity:
            'Semaglutide - Identity (HPLC), Tirzepatide - Identity (HPLC), Retatrutide - Identity (HPLC)',
          declared_weight_mg: 80,
        }),
      ]),
      opts
    )
    const { csv } = endoscanSampleCsv(
      doc.rows.map(r => r.sample),
      doc.ctx
    )
    // csv[0] is the byte-order mark; the header is the first line after it.
    const body = csv.slice(1).trimEnd().split(String.fromCharCode(13, 10)).slice(1)
    for (const line of body) {
      const sampleId = line.split(',')[2] ?? ''
      expect(sampleId.length).toBeLessThanOrEqual(40)
    }
  })
})
