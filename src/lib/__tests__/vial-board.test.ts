import { describe, it, expect } from 'vitest'
import {
  VIAL_STAGE_COLUMNS,
  DEFAULT_COLLAPSED_COLUMNS,
  DEFAULT_VIAL_BOARD_FILTERS,
  placeableAnalyses,
  stageCounts,
  vialColumns,
  isSplitVial,
  vialMatchesSampleId,
  vialMatchesAnalyte,
  vialMatchesTech,
  vialMatchesWorksheet,
  vialMatchesStages,
  vialMatchesRole,
  applyBoardFilters,
  sortVials,
  toggleKey,
  matrixCell,
  matrixOverall,
  buildMatrixRows,
  type BoardVialLike,
  type MatrixCell,
  type MatrixCellStatus,
} from '@/lib/vial-board'

function vial(over: Partial<BoardVialLike> = {}): BoardVialLike {
  return {
    sample_id: 'PB-0001-S01',
    assignment_role: 'hplc',
    received_at: '2026-08-27T14:02:00Z',
    parent: { sample_id: 'PB-0001', label: 'Semaglutide 5 mg' },
    analyses: [],
    worksheet: null,
    ...over,
  }
}

describe('VIAL_STAGE_COLUMNS', () => {
  it('has the six stages in lifecycle order and rejected collapsed by default', () => {
    expect(VIAL_STAGE_COLUMNS.map(c => c.key)).toEqual([
      'unassigned',
      'assigned',
      'to_be_verified',
      'promoted',
      'variance_verified',
      'rejected',
    ])
    expect(DEFAULT_COLLAPSED_COLUMNS).toEqual(['rejected'])
    expect(DEFAULT_VIAL_BOARD_FILTERS.collapsedCols).toEqual(['rejected'])
  })
})

describe('placement (spec §2 multi-column rule)', () => {
  it('places a card in every column with >=1 analysis in that state', () => {
    const v = vial({
      analyses: [
        { title: 'A', review_state: 'assigned' },
        { title: 'B', review_state: 'assigned' },
        { title: 'C', review_state: 'to_be_verified' },
      ],
    })
    expect(vialColumns(v)).toEqual(['assigned', 'to_be_verified'])
    expect(stageCounts(v)).toEqual({ assigned: 2, to_be_verified: 1 })
    expect(isSplitVial(v)).toBe(true)
  })

  it('single-column vial is not split', () => {
    const v = vial({ analyses: [{ title: 'A', review_state: 'unassigned' }] })
    expect(vialColumns(v)).toEqual(['unassigned'])
    expect(isSplitVial(v)).toBe(false)
  })

  it('retracted rows never place cards or count', () => {
    const v = vial({
      analyses: [
        { title: 'A', review_state: 'retracted' },
        { title: 'B', review_state: 'promoted' },
      ],
    })
    expect(placeableAnalyses(v.analyses).map(a => a.title)).toEqual(['B'])
    expect(vialColumns(v)).toEqual(['promoted'])
  })

  it('unknown states (defensive) place nothing', () => {
    const v = vial({ analyses: [{ title: 'A', review_state: 'parent_to_verify' }] })
    expect(vialColumns(v)).toEqual([])
  })
})

describe('filters', () => {
  it('sample-id search matches vial or parent id, empty query is a no-op', () => {
    const v = vial()
    expect(vialMatchesSampleId(v, '')).toBe(true)
    expect(vialMatchesSampleId(v, 'pb-0001-s01')).toBe(true)
    expect(vialMatchesSampleId(v, 'PB-0001')).toBe(true)
    expect(vialMatchesSampleId(v, 'PB-0002')).toBe(false)
  })

  it('analyte search matches analysis titles, ignoring retracted rows', () => {
    const v = vial({
      analyses: [
        { title: 'ENDO-LAL Endotoxin', review_state: 'retracted' },
        { title: 'Purity HPLC', review_state: 'assigned' },
      ],
    })
    expect(vialMatchesAnalyte(v, 'purity')).toBe(true)
    expect(vialMatchesAnalyte(v, 'endo')).toBe(false)
    expect(vialMatchesAnalyte(v, '')).toBe(true)
  })

  it('tech filter matches by analyst_user_id string', () => {
    const v = vial({
      analyses: [{ title: 'A', review_state: 'assigned', analyst_user_id: 7 }],
    })
    expect(vialMatchesTech(v, '')).toBe(true)
    expect(vialMatchesTech(v, '7')).toBe(true)
    expect(vialMatchesTech(v, '8')).toBe(false)
  })

  it('worksheet filter is exact-title, stage filter matches placement columns', () => {
    const v = vial({
      worksheet: { title: 'WS-2026-08-29-043' },
      analyses: [{ title: 'A', review_state: 'to_be_verified' }],
    })
    expect(vialMatchesWorksheet(v, 'WS-2026-08-29-043')).toBe(true)
    expect(vialMatchesWorksheet(v, 'WS-other')).toBe(false)
    expect(vialMatchesStages(v, [])).toBe(true)
    expect(vialMatchesStages(v, ['to_be_verified'])).toBe(true)
    expect(vialMatchesStages(v, ['assigned'])).toBe(false)
  })

  it('applyBoardFilters composes lane roles, sub-role, and all axes', () => {
    const hplc = vial({ analyses: [{ title: 'A', review_state: 'assigned' }] })
    const endo = vial({
      sample_id: 'PB-0002-S02',
      assignment_role: 'endo',
      parent: { sample_id: 'PB-0002' },
      analyses: [{ title: 'B', review_state: 'assigned' }],
    })
    const filters = {
      activeStages: [],
      sampleIdFilter: '',
      analyteFilter: '',
      techFilter: '',
      worksheetFilter: '',
    }
    expect(applyBoardFilters([hplc, endo], filters, ['endo', 'ster'], '')).toEqual([endo])
    expect(applyBoardFilters([hplc, endo], filters, null, '')).toEqual([hplc, endo])
    expect(applyBoardFilters([hplc, endo], filters, null, 'endo')).toEqual([endo])
    expect(vialMatchesRole(hplc, 'hplc')).toBe(true)
  })
})

describe('sortVials + toggleKey', () => {
  it('sorts by received_at asc (oldest first) and flips on dir', () => {
    const older = vial({ received_at: '2026-08-01T00:00:00Z' })
    const newer = vial({ sample_id: 'PB-0009-S01', received_at: '2026-08-30T00:00:00Z' })
    expect(sortVials([newer, older], 'received_at', 'asc')).toEqual([older, newer])
    expect(sortVials([newer, older], 'received_at', 'desc')).toEqual([newer, older])
    expect(sortVials([newer, older], 'sample_id', 'asc')[0]?.sample_id).toBe('PB-0001-S01')
  })

  it('toggleKey adds absent keys and removes present ones', () => {
    expect(toggleKey(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleKey(['a', 'b'], 'b')).toEqual(['a'])
  })
})

describe('matrixCell (spec §5 cell-status ladder)', () => {
  it('no analyses → not_ordered (visually distinct from not started)', () => {
    expect(matrixCell([])).toEqual({ status: 'not_ordered', done: 0, submitted: 0, total: 0 })
  })

  it('any rejected wins the ladder', () => {
    expect(
      matrixCell([
        { title: 'A', review_state: 'rejected' },
        { title: 'B', review_state: 'promoted' },
      ]).status
    ).toBe('rejected')
  })

  it('all promoted/variance_verified → complete', () => {
    const cell = matrixCell([
      { title: 'A', review_state: 'promoted' },
      { title: 'B', review_state: 'variance_verified' },
    ])
    expect(cell).toEqual({ status: 'complete', done: 2, submitted: 0, total: 2 })
  })

  it('any assigned/to_be_verified → in_progress with n/m counts', () => {
    const cell = matrixCell([
      { title: 'A', review_state: 'promoted' },
      { title: 'B', review_state: 'to_be_verified' },
      { title: 'C', review_state: 'assigned' },
    ])
    expect(cell).toEqual({ status: 'in_progress', done: 1, submitted: 1, total: 3 })
  })

  it('all unassigned → not_started; retracted rows are ignored entirely', () => {
    expect(
      matrixCell([
        { title: 'A', review_state: 'unassigned' },
        { title: 'B', review_state: 'retracted' },
      ])
    ).toEqual({ status: 'not_started', done: 0, submitted: 0, total: 1 })
  })

  it('promoted + unassigned mix is not_started per the spec ladder (no assigned/to_be_verified rows)', () => {
    // Deliberate spec choice (§5): In Progress requires >=1 assigned or
    // to_be_verified; done-but-not-all with the rest untouched reads as
    // Not Started with the n/m visible via done/total.
    const cell = matrixCell([
      { title: 'A', review_state: 'promoted' },
      { title: 'B', review_state: 'unassigned' },
    ])
    expect(cell.status).toBe('not_started')
    expect(cell.done).toBe(1)
  })
})

describe('matrixOverall (worst-of, spec §5)', () => {
  const cell = (status: MatrixCellStatus): MatrixCell =>
    ({ status, done: 0, submitted: 0, total: status === 'not_ordered' ? 0 : 1 })

  it('any rejected → issue', () => {
    expect(matrixOverall([cell('rejected'), cell('complete')])).toBe('issue')
  })

  it('any ordered role not complete → in_progress; not_ordered ignored', () => {
    expect(matrixOverall([cell('complete'), cell('in_progress'), cell('not_ordered')])).toBe('in_progress')
    expect(matrixOverall([cell('complete'), cell('not_started')])).toBe('in_progress')
  })

  it('all ordered complete → complete', () => {
    expect(matrixOverall([cell('complete'), cell('not_ordered')])).toBe('complete')
  })
})

describe('buildMatrixRows', () => {
  it('groups by parent, keys cells by role, aggregates techs/worksheets/received', () => {
    const rows = buildMatrixRows(
      [
        vial({
          sample_id: 'PB-0001-S01',
          assignment_role: 'hplc',
          received_at: '2026-08-27T14:02:00Z',
          worksheet: { title: 'WS-A' },
          analyses: [
            { title: 'Purity', review_state: 'promoted', analyst_name: 'J. Chen' },
          ],
        }),
        vial({
          sample_id: 'PB-0001-S02',
          assignment_role: 'endo',
          received_at: '2026-08-26T09:00:00Z',
          worksheet: { title: 'WS-B' },
          analyses: [
            { title: 'Endotoxin', review_state: 'assigned', analyst_name: 'R. Patel' },
          ],
        }),
      ],
      ['hplc', 'endo', 'ster']
    )
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.parentSampleId).toBe('PB-0001')
    expect(row?.cells.hplc?.status).toBe('complete')
    expect(row?.cells.endo?.status).toBe('in_progress')
    expect(row?.cells.ster?.status).toBe('not_ordered')
    expect(row?.overall).toBe('in_progress')
    expect(row?.techs.sort()).toEqual(['J. Chen', 'R. Patel'])
    expect(row?.worksheets.sort()).toEqual(['WS-A', 'WS-B'])
    expect(row?.earliestReceived).toBe('2026-08-26T09:00:00Z')
  })

  it('parents sort by sample_id and distinct-dedupes techs/worksheets', () => {
    const rows = buildMatrixRows(
      [
        vial({ parent: { sample_id: 'PB-0002' }, sample_id: 'PB-0002-S01' }),
        vial({
          sample_id: 'PB-0001-S01',
          worksheet: { title: 'WS-A' },
          analyses: [
            { title: 'A', review_state: 'assigned', analyst_name: 'J. Chen' },
            { title: 'B', review_state: 'assigned', analyst_name: 'J. Chen' },
          ],
        }),
      ],
      ['hplc']
    )
    expect(rows.map(r => r.parentSampleId)).toEqual(['PB-0001', 'PB-0002'])
    expect(rows[0]?.techs).toEqual(['J. Chen'])
    expect(rows[0]?.worksheets).toEqual(['WS-A'])
  })
})
