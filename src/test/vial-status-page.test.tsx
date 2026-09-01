import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { VialStatusPage } from '@/components/vial-board/VialStatusPage'
import { VIAL_BOARD_LANE_LS_KEY } from '@/lib/vial-board'
import type * as ApiModule from '@/lib/api'
import type { InboxLaneRow, VialBoardResponse } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    getVialBoard: vi.fn(),
    getInboxLanes: vi.fn(),
    getVialRoles: vi.fn(),
    getDepartments: vi.fn(),
    getWorksheetUsers: vi.fn(),
  }
})

import {
  getVialBoard,
  getInboxLanes,
  getVialRoles,
  getDepartments,
  getWorksheetUsers,
} from '@/lib/api'

const mockGetVialBoard = vi.mocked(getVialBoard)
const mockGetInboxLanes = vi.mocked(getInboxLanes)

const LANES: InboxLaneRow[] = [
  { key: 'hplc', label: 'Analytical', role_codes: ['hplc'], sort_order: 0 },
  { key: 'microbiology', label: 'Microbiology', role_codes: ['endo', 'ster'], sort_order: 1 },
]

const EMPTY_BOARD: VialBoardResponse = { total: 0, vials: [] }

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <VialStatusPage />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  mockGetInboxLanes.mockResolvedValue(LANES)
  mockGetVialBoard.mockResolvedValue(EMPTY_BOARD)
  vi.mocked(getVialRoles).mockResolvedValue([])
  vi.mocked(getDepartments).mockResolvedValue([])
  vi.mocked(getWorksheetUsers).mockResolvedValue([])
})

describe('VialStatusPage — lane chips + persistence', () => {
  it('renders a chip per catalog lane once lanes resolve', async () => {
    renderPage()
    expect(await screen.findByRole('button', { name: 'Analytical' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Microbiology' })).toBeInTheDocument()
  })

  it('falls back to the first lane when the stored key is stale, and persists the correction', async () => {
    window.localStorage.setItem(VIAL_BOARD_LANE_LS_KEY, 'a_deleted_department')
    renderPage()
    await screen.findByRole('button', { name: 'Analytical' })
    await waitFor(() =>
      expect(window.localStorage.getItem(VIAL_BOARD_LANE_LS_KEY)).toBe('hplc')
    )
  })

  it('shows the empty state when the board has no vials', async () => {
    renderPage()
    expect(await screen.findByText(/no vials/i)).toBeInTheDocument()
  })
})
