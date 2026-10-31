import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const mockUseFlagActivity = vi.fn()
vi.mock('@/hooks/use-flags', () => ({
  useFlagActivity: () => mockUseFlagActivity(),
}))
// Row pulls users/types/auth — stub to keep the feed test focused.
vi.mock('@/components/flags/FlagActivityRow', () => ({
  FlagActivityRow: ({
    item,
    returnTo,
  }: {
    item: { id: number; flag: { title: string } }
    returnTo?: string
  }) => <div data-return-to={String(returnTo)}>{item.flag.title}</div>,
}))

const page = (titles: string[], next: string | null) => ({
  items: titles.map((t, i) => ({ id: i + 1, flag: { title: t } })),
  next_cursor: next,
})

beforeEach(() => mockUseFlagActivity.mockReset())

describe('FlagActivityFeed', () => {
  it('renders rows and a Load more when there is a next page', async () => {
    const fetchNextPage = vi.fn()
    mockUseFlagActivity.mockReturnValue({
      data: { pages: [page(['a', 'b'], 'cur')] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
      fetchNextPage,
      hasNextPage: true,
      isFetchingNextPage: false,
    })
    const { FlagActivityFeed } =
      await import('@/components/flags/FlagActivityFeed')
    render(<FlagActivityFeed />)
    expect(screen.getByText('a')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Load more'))
    expect(fetchNextPage).toHaveBeenCalled()
  })

  it('shows the empty state when there is no activity', async () => {
    mockUseFlagActivity.mockReturnValue({
      data: { pages: [page([], null)] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    })
    const { FlagActivityFeed } =
      await import('@/components/flags/FlagActivityFeed')
    render(<FlagActivityFeed />)
    expect(screen.getByText('No activity yet')).toBeInTheDocument()
  })

  it('passes returnTo to its rows', async () => {
    mockUseFlagActivity.mockReturnValue({
      data: { pages: [page(['a'], null)] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    })
    const { FlagActivityFeed } =
      await import('@/components/flags/FlagActivityFeed')
    const flyout = render(<FlagActivityFeed />)
    expect(screen.getByText('a')).toHaveAttribute('data-return-to', 'undefined')
    flyout.unmount()
    render(<FlagActivityFeed returnTo="page" />)
    expect(screen.getByText('a')).toHaveAttribute('data-return-to', 'page')
  })
})
