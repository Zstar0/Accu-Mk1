import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { VialBoardKanban } from '@/components/vial-board/VialBoardKanban'
import { DEFAULT_VIAL_BOARD_FILTERS } from '@/lib/vial-board'
import type { BoardVial } from '@/lib/api'

const navigateToSample = vi.fn()
vi.mock('@/store/ui-store', () => ({
  useUIStore: Object.assign(vi.fn(), {
    getState: () => ({ navigateToSample }),
  }),
}))

function boardVial(over: Partial<BoardVial> = {}): BoardVial {
  return {
    id: 1,
    sample_id: 'PB-0463-S02',
    external_lims_uid: 'mk1://sub/1',
    assignment_role: 'endo',
    vial_sequence: 2,
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

const baseProps = {
  filters: DEFAULT_VIAL_BOARD_FILTERS,
  showAnalyses: false,
  groupBySample: false,
  collapsedCols: [] as string[],
  onToggleCollapse: vi.fn(),
  roleShort: (code: string) => code.toUpperCase(),
  roleChipClass: () => 'bg-sky-500/15',
}

describe('VialBoardKanban', () => {
  it('places a split vial card in every column with live work, with counts', () => {
    const v = boardVial({
      analyses: [
        {
          id: 1,
          title: 'Endotoxin',
          review_state: 'assigned',
          analyst_user_id: null,
          analyst_name: null,
        },
        {
          id: 2,
          title: 'Sterility',
          review_state: 'to_be_verified',
          analyst_user_id: null,
          analyst_name: null,
        },
      ],
    })
    render(<VialBoardKanban {...baseProps} vials={[v]} />)
    expect(screen.getAllByText('PB-0463-S02')).toHaveLength(2)
  })

  it('collapsed column hides its cards until the header is clicked', () => {
    const v = boardVial({
      analyses: [
        {
          id: 1,
          title: 'Endotoxin',
          review_state: 'rejected',
          analyst_user_id: null,
          analyst_name: null,
        },
        {
          id: 2,
          title: 'Sterility',
          review_state: 'assigned',
          analyst_user_id: null,
          analyst_name: null,
        },
      ],
    })
    const onToggleCollapse = vi.fn()
    render(
      <VialBoardKanban
        {...baseProps}
        vials={[v]}
        collapsedCols={['rejected']}
        onToggleCollapse={onToggleCollapse}
      />
    )
    // Card renders once (assigned) — the rejected copy is collapsed away.
    expect(screen.getAllByText('PB-0463-S02')).toHaveLength(1)
    fireEvent.click(screen.getByTitle('Expand Rejected'))
    expect(onToggleCollapse).toHaveBeenCalledWith('rejected')
  })

  it('card click navigates to the parent sample details', () => {
    const v = boardVial({
      analyses: [
        {
          id: 1,
          title: 'Endotoxin',
          review_state: 'assigned',
          analyst_user_id: null,
          analyst_name: null,
        },
      ],
    })
    render(<VialBoardKanban {...baseProps} vials={[v]} />)
    fireEvent.click(screen.getByText('PB-0463-S02'))
    expect(navigateToSample).toHaveBeenCalledWith('PB-0463')
  })

  it('showAnalyses lists matching analysis titles on the card', () => {
    const v = boardVial({
      analyses: [
        {
          id: 1,
          title: 'Endotoxin USP<85>',
          review_state: 'assigned',
          analyst_user_id: null,
          analyst_name: null,
        },
      ],
    })
    render(<VialBoardKanban {...baseProps} vials={[v]} showAnalyses={true} />)
    expect(screen.getByText('Endotoxin USP<85>')).toBeInTheDocument()
  })
})
