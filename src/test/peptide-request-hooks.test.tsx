import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

// Mock apiFetch before importing the hooks so the hooks pick up the mock.
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}))

const { apiFetch } = await import('@/lib/api')
const {
  usePeptideRequestsList,
  usePeptideRequest,
  usePeptideRequestHistory,
} = await import('@/hooks/peptide-requests')
const { ACTIVE_STATUSES, CLOSED_STATUSES } = await import(
  '@/types/peptide-request'
)

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

describe('peptide-request types', () => {
  it('ACTIVE_STATUSES has 6 entries', () => {
    expect(ACTIVE_STATUSES).toHaveLength(6)
    expect(ACTIVE_STATUSES).toContain('new')
    expect(ACTIVE_STATUSES).toContain('on_hold')
  })

  it('CLOSED_STATUSES has 3 entries', () => {
    expect(CLOSED_STATUSES).toHaveLength(3)
    expect(CLOSED_STATUSES).toEqual(['completed', 'rejected', 'cancelled'])
  })
})

describe('usePeptideRequestsList', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
  })

  it('builds URL with status comma-joined, limit, offset', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ total: 0, items: [] })

    const { result } = renderHook(
      () =>
        usePeptideRequestsList({
          status: ['new', 'approved'],
          limit: 25,
          offset: 10,
        }),
      { wrapper }
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(apiFetch).toHaveBeenCalledTimes(1)
    const calledWith = vi.mocked(apiFetch).mock.calls[0]![0] as string
    expect(calledWith.startsWith('/api/lims/peptide-requests?')).toBe(true)
    expect(calledWith).toContain('status=new%2Capproved')
    expect(calledWith).toContain('limit=25')
    expect(calledWith).toContain('offset=10')
  })

  it('omits params when not provided', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ total: 0, items: [] })

    const { result } = renderHook(() => usePeptideRequestsList({}), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const calledWith = vi.mocked(apiFetch).mock.calls[0]![0] as string
    expect(calledWith).toBe('/api/lims/peptide-requests?')
  })
})

describe('usePeptideRequest', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
  })

  it('returns the fetched record and calls the right path', async () => {
    const fake = {
      id: 'abc-123',
      compound_name: 'Semaglutide',
    } as unknown as Awaited<ReturnType<typeof apiFetch>>
    vi.mocked(apiFetch).mockResolvedValueOnce(fake)

    const { result } = renderHook(() => usePeptideRequest('abc-123'), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(apiFetch).toHaveBeenCalledWith('/api/lims/peptide-requests/abc-123')
    expect(result.current.data).toEqual(fake)
  })

  it('is disabled when id is empty', () => {
    const { result } = renderHook(() => usePeptideRequest(''), { wrapper })
    expect(result.current.fetchStatus).toBe('idle')
    expect(apiFetch).not.toHaveBeenCalled()
  })
})

describe('usePeptideRequestHistory', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
  })

  it('fetches from /history path', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce([])

    const { result } = renderHook(() => usePeptideRequestHistory('xyz-9'), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/lims/peptide-requests/xyz-9/history'
    )
  })

  it('is disabled when id is empty', () => {
    const { result } = renderHook(() => usePeptideRequestHistory(''), {
      wrapper,
    })
    expect(result.current.fetchStatus).toBe('idle')
    expect(apiFetch).not.toHaveBeenCalled()
  })
})
