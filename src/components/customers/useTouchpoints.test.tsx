import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/lib/api'
import * as supportApi from '@/lib/api-support'
import { useAuthStore, type AuthUser } from '@/store/auth-store'
import { useTouchpoints } from './useTouchpoints'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof api>('@/lib/api')
  return { ...actual, getCustomerTouchpoints: vi.fn() }
})
vi.mock('@/lib/api-support', async () => {
  const actual = await vi.importActual<typeof supportApi>('@/lib/api-support')
  return { ...actual, getSupportMe: vi.fn() }
})

const user = (role: string): AuthUser => ({
  id: 1,
  email: `${role}@accumark.example`,
  role,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  senaite_configured: false,
})
const noSeat: supportApi.SupportMe = {
  has_seat: false,
  plain_user_id: null,
  name: null,
  email: null,
  unavailable: false,
}
const settled = (crm: boolean, support: boolean): api.TouchpointsResponse => ({
  crm_visible: crm,
  support_visible: support,
  rows: { 'wc:1': { crm: null, support: null } },
})

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useTouchpoints', () => {
  afterEach(() => {
    useAuthStore.setState({ user: null })
    vi.mocked(api.getCustomerTouchpoints).mockReset()
    vi.mocked(supportApi.getSupportMe).mockReset()
  })

  it('chunks at 50, merges rows and degrades a failed chunk', async () => {
    vi.mocked(supportApi.getSupportMe).mockResolvedValue(noSeat)
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

  it('seeds both columns for an admin before the first response, then the server wins', async () => {
    useAuthStore.setState({ user: user('admin') })
    vi.mocked(supportApi.getSupportMe).mockResolvedValue(noSeat)
    let resolve: (v: api.TouchpointsResponse) => void = () => undefined
    vi.mocked(api.getCustomerTouchpoints).mockReturnValue(
      new Promise<api.TouchpointsResponse>(r => {
        resolve = r
      })
    )
    const { result } = renderHook(() => useTouchpoints(['wc:1']), { wrapper })
    expect(result.current.crmVisible).toBe(true)
    expect(result.current.supportVisible).toBe(true)
    expect(result.current.isLoading).toBe(true)
    expect(result.current.rows).toEqual({})
    resolve(settled(false, false))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.crmVisible).toBe(false)
    expect(result.current.supportVisible).toBe(false)
  })

  it('seeds nothing for a standard user without a seat, and a seat adds Support', async () => {
    useAuthStore.setState({ user: user('standard') })
    vi.mocked(supportApi.getSupportMe).mockResolvedValue({
      ...noSeat,
      has_seat: true,
    })
    vi.mocked(api.getCustomerTouchpoints).mockReturnValue(
      new Promise<api.TouchpointsResponse>(() => undefined)
    )
    const { result } = renderHook(() => useTouchpoints(['wc:1']), { wrapper })
    expect(result.current.crmVisible).toBe(false)
    expect(result.current.supportVisible).toBe(false)
    await waitFor(() => expect(result.current.supportVisible).toBe(true))
    expect(result.current.crmVisible).toBe(false)
  })
})
