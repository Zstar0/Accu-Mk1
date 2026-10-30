import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { documentKeys, useCreateRevision } from '@/services/documents'

vi.mock('@/lib/api-documents', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@/lib/api-documents')),
  createDocumentRevision: vi.fn(async () => ({ id: 11 })),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

describe('documents hooks', () => {
  it('a created revision invalidates every cached detail, not only lists', async () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)
    const { result } = renderHook(() => useCreateRevision(), { wrapper })
    await act(() => result.current.mutateAsync({ code: 'ART-0001', html: 'x' }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: documentKeys.details })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: documentKeys.lists })
  })

  it('content is keyed by revision AND content hash', () => {
    expect(documentKeys.content(7, 'abc')).toEqual([
      'documents',
      'content',
      7,
      'abc',
    ])
  })
})
