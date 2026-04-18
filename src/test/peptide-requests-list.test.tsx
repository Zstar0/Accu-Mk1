import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

// Mock the hooks module before importing the page so the page picks up the mock.
vi.mock('@/hooks/peptide-requests', () => ({
  usePeptideRequestsList: vi.fn(),
  usePeptideRequest: vi.fn(),
  usePeptideRequestHistory: vi.fn(),
}))

const { usePeptideRequestsList } = await import('@/hooks/peptide-requests')
const { PeptideRequestsList } = await import('@/pages/PeptideRequestsList')
const { ACTIVE_STATUSES, CLOSED_STATUSES } =
  await import('@/types/peptide-request')

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

interface ListHookReturn {
  isLoading: boolean
  isError: boolean
  data: { total: number; items: unknown[] } | undefined
}

function mockHookReturn(
  overrides: Partial<ListHookReturn> = {}
): ListHookReturn {
  return {
    isLoading: false,
    isError: false,
    data: { total: 0, items: [] },
    ...overrides,
  }
}

describe('PeptideRequestsList', () => {
  beforeEach(() => {
    vi.mocked(usePeptideRequestsList).mockReset()
  })

  it('renders Active and Closed tabs with Active as the default', () => {
    vi.mocked(usePeptideRequestsList).mockReturnValue(
      mockHookReturn() as unknown as ReturnType<typeof usePeptideRequestsList>
    )

    render(<PeptideRequestsList />, { wrapper })

    const activeTab = screen.getByRole('tab', { name: /active/i })
    const closedTab = screen.getByRole('tab', { name: /closed/i })
    expect(activeTab).toBeInTheDocument()
    expect(closedTab).toBeInTheDocument()
    expect(activeTab).toHaveAttribute('data-state', 'active')
    expect(closedTab).toHaveAttribute('data-state', 'inactive')

    // Default query should be with ACTIVE_STATUSES.
    expect(usePeptideRequestsList).toHaveBeenCalledWith({
      status: ACTIVE_STATUSES,
    })
  })

  it('re-queries with CLOSED_STATUSES when the Closed tab is clicked', async () => {
    vi.mocked(usePeptideRequestsList).mockReturnValue(
      mockHookReturn() as unknown as ReturnType<typeof usePeptideRequestsList>
    )
    const user = userEvent.setup()

    render(<PeptideRequestsList />, { wrapper })

    // Initial call — Active.
    expect(usePeptideRequestsList).toHaveBeenLastCalledWith({
      status: ACTIVE_STATUSES,
    })

    await user.click(screen.getByRole('tab', { name: /closed/i }))

    await waitFor(() => {
      expect(usePeptideRequestsList).toHaveBeenLastCalledWith({
        status: CLOSED_STATUSES,
      })
    })
  })

  it('renders the empty state when items is empty', () => {
    vi.mocked(usePeptideRequestsList).mockReturnValue(
      mockHookReturn({
        data: { total: 0, items: [] },
      }) as unknown as ReturnType<typeof usePeptideRequestsList>
    )

    render(<PeptideRequestsList />, { wrapper })

    expect(screen.getByText(/no requests/i)).toBeInTheDocument()
  })
})
