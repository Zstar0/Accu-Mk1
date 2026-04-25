import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

// Mock the hooks module before importing the page so the page picks up the mock.
vi.mock('@/hooks/clickup-users', () => ({
  useUnmappedClickupUsers: vi.fn(),
  useMapClickupUser: vi.fn(),
}))

const { useUnmappedClickupUsers, useMapClickupUser } = await import(
  '@/hooks/clickup-users'
)
const { AdminClickupUsers } = await import('@/pages/AdminClickupUsers')

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

interface MockRow {
  clickup_user_id: string
  accumk1_user_id: number | null
  clickup_username: string
  clickup_email: string | null
  auto_matched: boolean
}

interface ListHookReturn {
  isLoading: boolean
  isError: boolean
  data: MockRow[] | undefined
}

function listReturn(overrides: Partial<ListHookReturn> = {}): ListHookReturn {
  return {
    isLoading: false,
    isError: false,
    data: [],
    ...overrides,
  }
}

describe('AdminClickupUsers', () => {
  let mutate: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.mocked(useUnmappedClickupUsers).mockReset()
    vi.mocked(useMapClickupUser).mockReset()
    mutate = vi.fn()
    vi.mocked(useMapClickupUser).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useMapClickupUser>)
  })

  it('renders unmapped users and shows a checkmark for auto-matched rows', () => {
    vi.mocked(useUnmappedClickupUsers).mockReturnValue(
      listReturn({
        data: [
          {
            clickup_user_id: 'cu-1',
            accumk1_user_id: null,
            clickup_username: 'alice',
            clickup_email: 'alice@example.com',
            auto_matched: true,
          },
          {
            clickup_user_id: 'cu-2',
            accumk1_user_id: null,
            clickup_username: 'bob',
            clickup_email: null,
            auto_matched: false,
          },
        ],
      }) as unknown as ReturnType<typeof useUnmappedClickupUsers>
    )

    render(<AdminClickupUsers />, { wrapper })

    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
    // Alice is auto-matched — row should include the checkmark.
    const aliceRow = screen.getByText('alice').closest('tr')
    expect(aliceRow?.textContent).toContain('✓')
    const bobRow = screen.getByText('bob').closest('tr')
    expect(bobRow?.textContent).not.toContain('✓')
  })

  it('does not call mutate when Save is clicked with no input', async () => {
    vi.mocked(useUnmappedClickupUsers).mockReturnValue(
      listReturn({
        data: [
          {
            clickup_user_id: 'cu-1',
            accumk1_user_id: null,
            clickup_username: 'alice',
            clickup_email: 'alice@example.com',
            auto_matched: true,
          },
        ],
      }) as unknown as ReturnType<typeof useUnmappedClickupUsers>
    )
    const user = userEvent.setup()

    render(<AdminClickupUsers />, { wrapper })

    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(mutate).not.toHaveBeenCalled()
  })

  it('calls mutate with the entered user ID when Save is clicked', async () => {
    vi.mocked(useUnmappedClickupUsers).mockReturnValue(
      listReturn({
        data: [
          {
            clickup_user_id: 'cu-1',
            accumk1_user_id: null,
            clickup_username: 'alice',
            clickup_email: 'alice@example.com',
            auto_matched: true,
          },
        ],
      }) as unknown as ReturnType<typeof useUnmappedClickupUsers>
    )
    const user = userEvent.setup()

    render(<AdminClickupUsers />, { wrapper })

    const input = screen.getByPlaceholderText('User ID')
    await user.type(input, '42')
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith({
      clickupUserId: 'cu-1',
      accumk1UserId: 42,
    })
  })
})
