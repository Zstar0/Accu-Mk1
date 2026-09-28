import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return { ...actual, getRetestOptions: vi.fn(), createRetest: vi.fn() }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { createRetest, getRetestOptions } from '@/lib/api'
import { toast } from 'sonner'
import { useCreateRetest, useRetestOptions } from '@/hooks/use-retest'

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    qc,
    Wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  }
}

describe('useRetestOptions', () => {
  it('fetches only when enabled', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({
      sample_id: 'P-1',
      status: null,
      order_number: null,
      profiles: [],
      addons: [],
      variance: { point_price: null, allowed: false },
      prices_available: false,
    })
    const { Wrapper } = wrapper()
    const { result, rerender } = renderHook(
      ({ on }) => useRetestOptions('P-1', on),
      { wrapper: Wrapper, initialProps: { on: false } }
    )
    expect(getRetestOptions).not.toHaveBeenCalled()
    rerender({ on: true })
    await waitFor(() => expect(result.current.data?.sample_id).toBe('P-1'))
  })
})

describe('useCreateRetest', () => {
  it('toasts with the order number and the payment hint, invalidates, calls onCreated', async () => {
    vi.mocked(createRetest).mockResolvedValue({
      order_number: 'WP-7920',
      payment_url: 'https://x',
    })
    const { qc, Wrapper } = wrapper()
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const onCreated = vi.fn()
    const { result } = renderHook(() => useCreateRetest('P-1', { onCreated }), {
      wrapper: Wrapper,
    })
    await act(async () => {
      await result.current.mutateAsync({
        retest: ['x'],
        carry: [],
        add: null,
        auto_checkin: false,
        fee: 'paid',
        reason: 'r',
      })
    })
    expect(toast.success).toHaveBeenCalledWith(
      'Retest order WP-7920 created',
      expect.objectContaining({
        description: expect.stringMatching(/waiting for payment/i),
      })
    )
    expect(spy).toHaveBeenCalledWith({ queryKey: ['ordered-products', 'P-1'] })
    expect(onCreated).toHaveBeenCalledWith({
      order_number: 'WP-7920',
      payment_url: 'https://x',
    })
  })
  it('gives the payment toast a 15s duration and a Copy link action', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    vi.mocked(createRetest).mockResolvedValue({
      order_number: 'WP-7920',
      payment_url: 'https://accumarklabs.com/checkout/order-pay/7920',
    })
    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useCreateRetest('P-1', {}), {
      wrapper: Wrapper,
    })
    await act(async () => {
      await result.current.mutateAsync({
        retest: ['x'],
        carry: [],
        add: null,
        auto_checkin: false,
        fee: 'paid',
        reason: 'r',
      })
    })
    expect(toast.success).toHaveBeenCalledWith(
      'Retest order WP-7920 created',
      expect.objectContaining({
        duration: 15000,
        action: expect.objectContaining({ label: 'Copy link' }),
      })
    )
    const calls = vi.mocked(toast.success).mock.calls
    const opts = calls[calls.length - 1]?.[1] as unknown as {
      action: { onClick: (e: unknown) => void }
    }
    opts.action.onClick(undefined)
    expect(writeText).toHaveBeenCalledWith(
      'https://accumarklabs.com/checkout/order-pay/7920'
    )
  })
  it('toasts the server detail on failure', async () => {
    vi.mocked(createRetest).mockRejectedValue(
      new Error('Integration Service returned 502')
    )
    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useCreateRetest('P-1', {}), {
      wrapper: Wrapper,
    })
    await act(async () => {
      await result.current
        .mutateAsync({
          retest: ['x'],
          carry: [],
          add: null,
          auto_checkin: false,
          fee: 'paid',
          reason: 'r',
        })
        .catch(() => undefined)
    })
    expect(toast.error).toHaveBeenCalledWith('Retest failed', {
      description: 'Integration Service returned 502',
    })
  })
  it('toasts without double space when order_number is missing', async () => {
    vi.mocked(createRetest).mockResolvedValue({})
    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useCreateRetest('P-1', {}), {
      wrapper: Wrapper,
    })
    await act(async () => {
      await result.current.mutateAsync({
        retest: ['x'],
        carry: [],
        add: null,
        auto_checkin: false,
        fee: 'paid',
        reason: 'r',
      })
    })
    expect(toast.success).toHaveBeenCalledWith(
      'Retest order created',
      expect.any(Object)
    )
  })
})
