import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import * as api from '@/lib/api'
import { useTouchpoints } from './useTouchpoints'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof api>('@/lib/api')
  return { ...actual, getCustomerTouchpoints: vi.fn() }
})

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
)

describe('useTouchpoints', () => {
  it('chunks at 50, merges rows and degrades a failed chunk', async () => {
    const keys = Array.from({ length: 51 }, (_, i) => `wc:${i}`)
    vi.mocked(api.getCustomerTouchpoints)
      .mockResolvedValueOnce({
        crm_visible: true,
        support_visible: true,
        rows: Object.fromEntries(
          keys.slice(0, 50).map(k => [
            k,
            {
              crm: { state: 'none', stale: false, reason: null },
              support: null,
            },
          ])
        ),
      })
      .mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useTouchpoints(keys), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(vi.mocked(api.getCustomerTouchpoints)).toHaveBeenCalledTimes(2)
    expect(
      vi.mocked(api.getCustomerTouchpoints).mock.calls[0]?.[0]
    ).toHaveLength(50)
    expect(result.current.crmVisible).toBe(true)
    expect(result.current.rows['wc:0']?.crm?.state).toBe('none')
    expect(result.current.rows['wc:50']?.crm?.state).toBe('unavailable')
  })
})
