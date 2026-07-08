import { beforeEach, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { useEffectiveReadSource } from '@/lib/read-source'
import * as api from '@/lib/api'
import { vi } from 'vitest'

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

beforeEach(() => sessionStorage.clear())

it('resolves global default then override', async () => {
  vi.spyOn(api, 'getSettings').mockResolvedValue([
    { key: 'registry_read_source', value: '{"sample_details":"mk1"}' } as api.Setting,
  ])
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { result } = renderHook(() => useEffectiveReadSource('sample_details'), { wrapper: wrapper(qc) })
  // global default resolves to mk1 once settings load
  await vi.waitFor(() => expect(result.current.effective).toBe('mk1'))
  // per-page override wins
  act(() => result.current.setOverride('senaite'))
  expect(result.current.effective).toBe('senaite')
})
