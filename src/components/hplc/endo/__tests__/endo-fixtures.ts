import { vi } from 'vitest'
import type { WorksheetListItem } from '@/lib/api'
import type { EndoPrepRule } from '@/lib/endo-prep-rules'
import type { WorksheetItemRow } from '@/lib/endo-worksheet'
import type { ReaderTest } from '@/lib/endo-reader'
import {
  allowedCartridges,
  endoCtxFor,
  endoRowsFor,
} from '@/lib/endo-worksheet-2ml'
import type { EndoBoxProps } from '@/components/hplc/endo/EndoBox'

let nextId = 100

/**
 * A 2 mL endotoxin vial row carrying every key the endo boxes read
 * (Task 10 serializer keys included). Override what a test needs.
 */
export function endoItem(
  over: Partial<WorksheetItemRow> = {}
): WorksheetItemRow {
  nextId += 1
  return {
    id: nextId,
    sample_id: `P-${nextId}-S02`,
    sample_uid: `mk1://${nextId}`,
    service_group_id: null,
    department_id: 3,
    department_name: 'Microbiology',
    group_name: 'Microbiology',
    group_color: '#888888',
    priority: 'normal',
    added_at: null,
    date_received: '2026-10-09T16:00:00Z',
    instrument_uid: null,
    instrument_id: null,
    assigned_analyst_id: null,
    assigned_analyst_email: null,
    notes: null,
    peptide_id: null,
    method_name: null,
    stamped_method_name: null,
    stamped_instrument_name: null,
    lims_sub_sample_pk: nextId,
    assignment_kind: 'core',
    assignment_role: 'endo',
    box_id: null,
    box_label: null,
    analyses: [
      {
        title: 'Endotoxin (LAL)',
        keyword: 'ENDO-LAL',
        analysis_service_id: 61,
        peptide_name: null,
        method: null,
      },
    ],
    prep_status: 'ready',
    declared_weight_mg: 10,
    sample_type: 'Peptide',
    client_order_number: 'WP-8860',
    sample_identity: 'Retatrutide',
    made_at: null,
    ran_at: null,
    prep_form: null,
    prep_water_ml: null,
    prep_total_dilution: null,
    prep_steps: null,
    cartridge_type_id: null,
    cartridge_sensitivity_eu_ml: null,
    result_reading: null,
    result_reader: null,
    result_entered_at: null,
    result_entered_by_user_id: null,
    ...over,
  }
}

/**
 * A 2 mL worksheet as GET /worksheets/{id} returns it: run cartridge 3
 * (0.05 EU/mL, the method default), method 12 allowing 0.05 and 0.01.
 */
export function endoWorksheet(
  items: WorksheetItemRow[],
  over: Partial<WorksheetListItem> = {}
): WorksheetListItem {
  return {
    id: 77,
    title: 'Endo 10/09/2026 #1',
    status: 'open',
    notes: null,
    assigned_analyst: 5,
    assigned_analyst_email: 'analyst@example.com',
    item_count: items.length,
    created_at: '2026-10-09T15:00:00Z',
    completed_at: null,
    endo_prep: '2ml',
    cartridge_type_id: 3,
    cartridge_sensitivity_eu_ml: 0.05,
    endo_method_id: null,
    endo_method: {
      id: 12,
      name: 'Endotoxin (LAL)',
      revision: 2,
      status: 'active',
      run_parameters: null,
      cartridges: [
        {
          id: 3,
          name: 'Endosafe 0.05',
          sensitivity_eu_ml: 0.05,
          is_default: true,
          active: true,
        },
        {
          id: 4,
          name: 'Endosafe 0.01',
          sensitivity_eu_ml: 0.01,
          is_default: false,
          active: true,
        },
      ],
    },
    items,
    ...over,
  }
}

/** The props the page hands Boxes 2 and 3, for these items in this order,
 *  under these live rule lines (slice 5). */
export function endoBoxProps(
  items: WorksheetItemRow[],
  over: Partial<WorksheetListItem> = {},
  isCompleted = false,
  rules: EndoPrepRule[] = []
): { props: EndoBoxProps; onUpdateItem: ReturnType<typeof vi.fn> } {
  const worksheet = endoWorksheet(items, over)
  const onUpdateItem = vi.fn()
  return {
    props: {
      worksheet,
      rows: endoRowsFor(items, worksheet, [], rules),
      ctx: endoCtxFor(worksheet),
      cartridges: allowedCartridges(worksheet),
      isCompleted,
      onUpdateItem,
    },
    onUpdateItem,
  }
}

// A made-up test in the reader's shape; never real results.
export function readerTest(over: Partial<ReaderTest> = {}): ReaderTest {
  return {
    testId: 'T1',
    sampleId: 'P-0001-S02',
    identity: 'Retatrutide',
    sampleType: 'Peptide',
    result: '<0.05',
    lt: true,
    value: 0.05,
    sampleCv: 3.1,
    spikeCv: 3.7,
    cvLimit: 25,
    recovery: 87,
    recMin: 50,
    recMax: 200,
    spikeLevel: 0.8,
    readerPass: true,
    operator: 'QA',
    testedAt: '2026-10-09 14:02',
    reader: 'MCS-1234',
    slot: 2,
    tempStart: 37,
    tempEnd: 37.1,
    cartLot: 'L1',
    cartExpiry: '2027-01-31',
    cartRange: '5 - 0.05',
    software: '1.0',
    ...over,
  }
}
