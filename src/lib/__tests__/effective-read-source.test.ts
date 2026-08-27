import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { useEffectiveReadSource, parseCoaGenerationSource, coaSourceLabel, coaSourceBadgeLabel, parseGlobalReadSource } from '@/lib/read-source'
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

describe('parseCoaGenerationSource', () => {
  it('defaults to senaite for absent/malformed raw', () => {
    expect(parseCoaGenerationSource(undefined)).toBe('senaite')
    expect(parseCoaGenerationSource(null)).toBe('senaite')
    expect(parseCoaGenerationSource('not json')).toBe('senaite')
    expect(parseCoaGenerationSource('[]')).toBe('senaite')
  })

  it('reads coa_generation from the shared map', () => {
    expect(parseCoaGenerationSource(JSON.stringify({ coa_generation: 'mk1' }))).toBe('mk1')
    expect(parseCoaGenerationSource(JSON.stringify({ sample_details: 'mk1' }))).toBe('senaite')
    expect(parseCoaGenerationSource(JSON.stringify({ coa_generation: 'bogus' }))).toBe('senaite')
  })

  it('is NOT a page key — parseGlobalReadSource must ignore it', () => {
    const map = parseGlobalReadSource(JSON.stringify({ coa_generation: 'mk1' }))
    expect(map).toEqual({})
  })
})

describe('coaSourceLabel', () => {
  it('labels both sources', () => {
    expect(coaSourceLabel('senaite')).toBe('SENAITE')
    expect(coaSourceLabel('mk1')).toBe('Accu-Mk1')
  })
})

describe('coaSourceBadgeLabel', () => {
  it('shows the toggle label on parent pages', () => {
    expect(coaSourceBadgeLabel('mk1', true)).toBe('Accu-Mk1')
    expect(coaSourceBadgeLabel('senaite', true)).toBe('SENAITE')
  })

  it('always shows SENAITE on sub-sample pages — that path ignores the toggle', () => {
    // Backend gates the wire document to parents (main.py is_sub); the badge
    // must say what the backend will actually do, not what the toggle says.
    expect(coaSourceBadgeLabel('mk1', false)).toBe('SENAITE')
    expect(coaSourceBadgeLabel('senaite', false)).toBe('SENAITE')
  })
})
