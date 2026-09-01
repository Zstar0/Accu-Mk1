import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VialBoardMatrix } from '@/components/vial-board/VialBoardMatrix'
import type { BoardVial } from '@/lib/api'

vi.mock('@/store/ui-store', () => ({
  useUIStore: Object.assign(vi.fn(), {
    getState: () => ({ navigateToSample: vi.fn() }),
  }),
}))

function boardVial(over: Partial<BoardVial> = {}): BoardVial {
  return {
    id: 1,
    sample_id: 'PB-0463-S01',
    external_lims_uid: 'mk1://sub/1',
    assignment_role: 'hplc',
    vial_sequence: 1,
    received_at: '2026-08-27T14:02:00Z',
    parent: {
      id: 401,
      sample_id: 'PB-0463',
      label: 'Semaglutide 5 mg',
      client_sample_id: null,
      priority: 'normal',
      is_test_order: false,
    },
    analyses: [],
    worksheet: null,
    ...over,
  }
}

describe('VialBoardMatrix', () => {
  it('renders one row per parent with role columns; not-ordered renders as a dash', () => {
    const v = boardVial({
      analyses: [
        {
          id: 1,
          title: 'Purity',
          review_state: 'promoted',
          analyst_user_id: 7,
          analyst_name: 'J. Chen',
        },
      ],
      worksheet: { id: 5, title: 'WS-2026-08-29-043', status: 'open' },
    })
    render(
      <VialBoardMatrix
        vials={[v]}
        laneVials={[v]}
        roleCodes={['hplc', 'endo']}
        roleLabel={code => (code === 'hplc' ? 'HPLC' : 'Endotoxin')}
      />
    )
    expect(screen.getByText('PB-0463')).toBeInTheDocument()
    expect(screen.getByText('HPLC')).toBeInTheDocument()
    expect(screen.getByText('Endotoxin')).toBeInTheDocument()
    // A single ordered role (hplc) that's complete rolls the row's Overall
    // up to complete too (worst-of), so "Complete" renders twice — the role
    // cell's badge and the Overall badge. DEVIATION from task-8-brief.md
    // Step 1's bare `getByText('Complete')`, which throws
    // "Found multiple elements" against the brief's own verbatim Step 3
    // implementation (CELL_STATUS_LABEL.complete and OVERALL_LABEL.complete
    // are both literally 'Complete' by design); getAllByText asserts the
    // same fact without picking a side to rename.
    expect(screen.getAllByText('Complete')).toHaveLength(2)
    expect(screen.getByText('— not ordered')).toBeInTheDocument()
    expect(screen.getByText('J. Chen')).toBeInTheDocument()
    expect(screen.getByText('WS-2026-08-29-043')).toBeInTheDocument()
  })

  it('in-progress cell shows the n/m promoted sub-line (or submitted when none promoted)', () => {
    const promoted = boardVial({
      analyses: [
        {
          id: 1,
          title: 'A',
          review_state: 'promoted',
          analyst_user_id: null,
          analyst_name: null,
        },
        {
          id: 2,
          title: 'B',
          review_state: 'assigned',
          analyst_user_id: null,
          analyst_name: null,
        },
        {
          id: 3,
          title: 'C',
          review_state: 'to_be_verified',
          analyst_user_id: null,
          analyst_name: null,
        },
      ],
    })
    const { rerender } = render(
      <VialBoardMatrix
        vials={[promoted]}
        laneVials={[promoted]}
        roleCodes={['hplc']}
        roleLabel={() => 'HPLC'}
      />
    )
    expect(screen.getByText('1/3 promoted')).toBeInTheDocument()

    const submittedOnly = boardVial({
      analyses: [
        {
          id: 1,
          title: 'A',
          review_state: 'to_be_verified',
          analyst_user_id: null,
          analyst_name: null,
        },
        {
          id: 2,
          title: 'B',
          review_state: 'assigned',
          analyst_user_id: null,
          analyst_name: null,
        },
      ],
    })
    rerender(
      <VialBoardMatrix
        vials={[submittedOnly]}
        laneVials={[submittedOnly]}
        roleCodes={['hplc']}
        roleLabel={() => 'HPLC'}
      />
    )
    expect(screen.getByText('1/2 submitted')).toBeInTheDocument()
  })

  it('overall is worst-of: a rejected role renders Issue', () => {
    const v = boardVial({
      analyses: [
        {
          id: 1,
          title: 'A',
          review_state: 'rejected',
          analyst_user_id: null,
          analyst_name: null,
        },
      ],
    })
    render(
      <VialBoardMatrix
        vials={[v]}
        laneVials={[v]}
        roleCodes={['hplc']}
        roleLabel={() => 'HPLC'}
      />
    )
    expect(screen.getByText('Issue')).toBeInTheDocument()
  })
})
