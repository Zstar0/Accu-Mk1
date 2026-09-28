import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'

const h = vi.hoisted(() => ({
  patchPositions: vi.fn(),
  deleteNode: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock('@/lib/api-boards', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    patchPositions: h.patchPositions,
    deleteNode: h.deleteNode,
  }
})
vi.mock('sonner', () => ({ toast: { error: h.toastError, success: vi.fn() } }))
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: { user: { role: string } }) => unknown) =>
    sel({ user: { role: 'standard' } }),
}))

import { boardKeys, useDeleteNode, usePatchPositions } from '@/services/boards'

describe('usePatchPositions', () => {
  beforeEach(() => {
    h.patchPositions.mockReset()
    h.toastError.mockReset()
  })

  it('a 409 invalidates the board and toasts (Review Focus 2)', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    h.patchPositions.mockRejectedValue(
      new Error('PATCH /api/boards/org/nodes/positions failed: 409')
    )
    const { result } = renderHook(() => usePatchPositions('org'), { wrapper })
    result.current.mutate([{ id: 1, x: 0, y: 0, version: 1 }])
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith(
        'Board changed elsewhere, reloaded'
      )
    )
    expect(spy).toHaveBeenCalledWith({ queryKey: boardKeys.detail('org') })
  })
})

describe('useDeleteNode', () => {
  it('a 409 names the open flags, not a stale board (I1)', async () => {
    h.toastError.mockReset()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    h.deleteNode.mockRejectedValue(
      new Error('DELETE /api/boards/org/nodes/7 failed: 409')
    )
    const { result } = renderHook(() => useDeleteNode('org'), { wrapper })
    result.current.mutate(7)
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith(
        'This item has open flags. Resolve them first.'
      )
    )
    expect(h.toastError).not.toHaveBeenCalledWith(
      'Board changed elsewhere, reloaded'
    )
    expect(spy).toHaveBeenCalledWith({ queryKey: boardKeys.detail('org') })
  })
})
