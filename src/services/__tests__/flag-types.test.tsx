import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import * as api from '@/lib/flags-api'
import {
  flagTypeKeys,
  useFlagTypes,
  useFlagEntityTypes,
  useFlagTypesMap,
} from '@/services/flag-types'

const customType: api.FlagType = {
  id: 99,
  slug: 'vial_only',
  label: 'Vial Only',
  color: '#abcdef',
  kind: 'issue',
  is_blocking: false,
  is_active: false, // deactivated — must still resolve in the map
  sort_order: 9,
  entity_types: ['sub_sample'],
  is_builtin: false,
}

vi.mock('@/lib/flags-api', async () => {
  const actual = (await vi.importActual('@/lib/flags-api')) as Record<
    string,
    unknown
  >
  return {
    ...actual,
    getFlagTypes: vi.fn(async () => []),
    getFlagEntityTypes: vi.fn(async () => [
      'sample',
      'sub_sample',
      'worksheet',
    ]),
  }
})

function makeWrapper(qc: QueryClient) {
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
  Wrapper.displayName = 'TestWrapper'
  return Wrapper
}

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe('flagTypeKeys', () => {
  it('produces stable, scoped query keys', () => {
    expect(flagTypeKeys.all).toEqual(['flag-types'])
    expect(flagTypeKeys.list()).toEqual(['flag-types', 'list', {}])
    expect(flagTypeKeys.list({ active_only: true })).toEqual([
      'flag-types',
      'list',
      { active_only: true },
    ])
    expect(flagTypeKeys.entityTypes).toEqual(['flag-types', 'entity-types'])
  })
})

describe('useFlagTypes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes params through to the endpoint', async () => {
    renderHook(
      () => useFlagTypes({ entity_type: 'sub_sample', active_only: true }),
      {
        wrapper: makeWrapper(newQc()),
      }
    )
    await waitFor(() =>
      expect(api.getFlagTypes).toHaveBeenCalledWith({
        entity_type: 'sub_sample',
        active_only: true,
      })
    )
  })
})

describe('useFlagEntityTypes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches the registered entity-type slugs', async () => {
    const { result } = renderHook(() => useFlagEntityTypes(), {
      wrapper: makeWrapper(newQc()),
    })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data).toEqual(['sample', 'sub_sample', 'worksheet'])
  })
})

describe('useFlagTypesMap', () => {
  beforeEach(() => vi.clearAllMocks())

  it('falls back to the static catalog before data loads', () => {
    vi.mocked(api.getFlagTypes).mockImplementation(async () => [])
    const { result } = renderHook(() => useFlagTypesMap(), {
      wrapper: makeWrapper(newQc()),
    })
    // Static fallback is present synchronously — pills never render colorless.
    expect(result.current.blocker).toMatchObject({
      label: 'Blocker',
      color: '#e5484d',
      kind: 'issue',
    })
  })

  it('includes INACTIVE types so deactivated-but-used pills keep their color', async () => {
    vi.mocked(api.getFlagTypes).mockImplementation(async () => [customType])
    const { result } = renderHook(() => useFlagTypesMap(), {
      wrapper: makeWrapper(newQc()),
    })
    await waitFor(() => expect(result.current.vial_only).toBeDefined())
    expect(result.current.vial_only).toMatchObject({
      label: 'Vial Only',
      color: '#abcdef',
      kind: 'issue',
    })
    // Built-ins still present (overlay, not replace).
    expect(result.current.blocker?.color).toBe('#e5484d')
  })

  it('queries WITHOUT active_only so inactive types are included', async () => {
    renderHook(() => useFlagTypesMap(), { wrapper: makeWrapper(newQc()) })
    await waitFor(() => expect(api.getFlagTypes).toHaveBeenCalled())
    expect(api.getFlagTypes).toHaveBeenCalledWith({})
  })
})
