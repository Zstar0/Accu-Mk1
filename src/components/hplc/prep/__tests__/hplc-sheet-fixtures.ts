import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { HplcSheet, HplcSheetRow } from '@/lib/api'
import type {
  HplcPrepInputs,
  HplcRowFacts,
  HplcRunParams,
} from '@/lib/hplc-prep'

// The compute_row fixture (Task 3), read at run time so no test imports a
// file under backend/. Its expected figures are what the sheet must show.
interface FixtureCase {
  name: string
  facts: HplcRowFacts
  inputs: HplcPrepInputs | null
  expect: Record<string, unknown>
}
export const fixture = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../../../backend/tests/fixtures/hplc_prep_cases.json'
    ),
    'utf8'
  )
) as { params: HplcRunParams; cases: FixtureCase[] }

export function fixtureCase(name: string): FixtureCase {
  const c = fixture.cases.find(x => x.name === name)
  if (!c) throw new Error(`no fixture case ${name}`)
  return c
}

/** A row's facts as GET /worksheets/{id}/hplc serves them. */
export function makeRow(over: Partial<HplcSheetRow> = {}): HplcSheetRow {
  return {
    item_id: 311,
    sample_id: 'P-0120-S01',
    parent_sample_id: 'P-0120',
    order_number: 'WP-5541',
    identity: 'BPC-157',
    peptide_id: 10,
    peptide_name: 'BPC-157',
    is_blend: false,
    components: [
      {
        peptide_id: 10,
        name: 'BPC-157',
        abbreviation: 'BPC-157',
        declared_mg: 10,
        vial: 1,
      },
    ],
    components_source: 'analytes',
    declared_mg: 10,
    sample_form: { id: 1, name: 'Lyophilized Powder', hplc_prep: 'powder' },
    sample_bac: false,
    form: 'powder',
    rider_only: false,
    instrument_id: 2,
    instrument_name: 'HPLC 1290a',
    params: fixture.params,
    prep_form: null,
    hplc_prep: {},
    promoted: false,
    prep: null,
    problems: [],
    other_preps: [],
    ...over,
  }
}

/** A row built from one fixture case: its facts and its typed inputs. */
export function rowFromCase(
  name: string,
  over: Partial<HplcSheetRow> = {}
): HplcSheetRow {
  const c = fixtureCase(name)
  return makeRow({
    declared_mg: c.facts.declared_mg,
    form: c.facts.form,
    peptide_id: c.facts.peptide_id,
    components: c.facts.components,
    hplc_prep: c.inputs ?? {},
    ...over,
  })
}

export function makeSheet(rows: HplcSheetRow[], status = 'open'): HplcSheet {
  return { worksheet_id: 7, status, blend_cap: 4, rows }
}

export const INSTRUMENTS = [
  { id: 2, name: 'HPLC 1290a' },
  { id: 3, name: 'HPLC 1290b' },
]
