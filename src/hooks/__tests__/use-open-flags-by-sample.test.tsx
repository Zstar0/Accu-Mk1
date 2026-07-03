import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import type { FlagResponse } from '@/lib/flags-api'
import type { FlagTypeDef } from '@/components/flags/flag-catalog'
import {
  buildRollupMap,
  rollupForSamples,
  useOpenFlagsBySample,
} from '@/hooks/use-open-flags-by-sample'

// The hook reads one all_open list + the type-color map; mock both so the test
// drives the rollup logic, not the network.
const useFlagsList = vi.fn()
vi.mock('@/hooks/use-flags', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    useFlagsList: (...args: unknown[]) => useFlagsList(...args),
  }
})

const TYPES_MAP: Record<string, FlagTypeDef> = {
  blocker: { label: 'Blocker', color: '#e5484d', kind: 'issue' },
  critical: { label: 'Critical', color: '#e8730a', kind: 'issue' },
  question: { label: 'Question', color: '#3b82f6', kind: 'issue' },
  waiting_on_customer: { label: 'Waiting', color: '#8b5cf6', kind: 'issue' },
}
vi.mock('@/services/flag-types', () => ({
  useFlagTypesMap: () => TYPES_MAP,
}))

/** Flag factory. `sampleId` populates the Plan-4 resolved entity.sample_id. */
function f(
  id: number,
  opts: {
    type?: string
    status?: string
    entityType?: string
    entityId?: string
    sampleId?: string | null
  } = {}
): FlagResponse {
  const {
    type = 'blocker',
    status = 'open',
    entityType = 'sub_sample',
    entityId = String(id),
    sampleId = 'P-0001',
  } = opts
  return {
    id,
    entity_type: entityType,
    entity_id: entityId,
    kind: 'issue',
    type,
    status,
    title: `flag ${id}`,
    created_by: 1,
    assignee_id: null,
    created_at: '2026-06-30T12:00:00',
    updated_at: '2026-06-30T12:00:00',
    resolved_at: null,
    resolved_by: null,
    entity: sampleId
      ? {
          entity_type: entityType,
          entity_id: entityId,
          label: entityId,
          sample_id: sampleId,
          analyses: [],
          lot: null,
          deep_link: { kind: 'sample', id: sampleId },
        }
      : null,
  }
}

function makeWrapper(qc: QueryClient) {
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
  Wrapper.displayName = 'TestWrapper'
  return Wrapper
}

describe('buildRollupMap', () => {
  it('groups vial (sub_sample) flags under their parent sample_id', () => {
    const map = buildRollupMap(
      [
        // A sample-level flag keyed directly by its own id.
        f(1, { entityType: 'sample', entityId: 'P-0001', sampleId: 'P-0001' }),
        // A vial flag carrying the parent sample_id → same bucket.
        f(2, { entityType: 'sub_sample', entityId: '99', sampleId: 'P-0001' }),
        // A different sample.
        f(3, { entityType: 'sample', entityId: 'P-0002', sampleId: 'P-0002' }),
      ],
      TYPES_MAP
    )
    expect(map.get('P-0001')?.count).toBe(2)
    expect(
      map
        .get('P-0001')
        ?.flags.map(x => x.id)
        .sort()
    ).toEqual([1, 2])
    expect(map.get('P-0002')?.count).toBe(1)
  })

  it('dominantType is the most severe open type and resolves its color', () => {
    const map = buildRollupMap(
      [
        f(1, { type: 'question', sampleId: 'P-0001' }),
        f(2, { type: 'blocker', sampleId: 'P-0001' }),
        f(3, { type: 'waiting_on_customer', sampleId: 'P-0001' }),
      ],
      TYPES_MAP
    )
    const r = map.get('P-0001')
    expect(r?.dominantType).toBe('blocker')
    expect(r?.dominantColor).toBe('#e5484d')
  })

  it('skips flags with no resolvable sample (e.g. worksheet flags)', () => {
    const map = buildRollupMap(
      [
        f(1, { entityType: 'worksheet', entityId: '7', sampleId: null }),
        f(2, { type: 'blocker', sampleId: 'P-0001' }),
      ],
      TYPES_MAP
    )
    expect(map.has('7')).toBe(false)
    expect(map.size).toBe(1)
    expect(map.get('P-0001')?.count).toBe(1)
  })

  it('ignores non-open (resolved/closed) flags', () => {
    const map = buildRollupMap(
      [
        f(1, { status: 'resolved', sampleId: 'P-0001' }),
        f(2, { status: 'open', sampleId: 'P-0001' }),
      ],
      TYPES_MAP
    )
    expect(map.get('P-0001')?.count).toBe(1)
  })
})

describe('rollupForSamples', () => {
  it('merges several samples into one aggregate rollup, dominant color from worst type', () => {
    const map = buildRollupMap(
      [
        f(1, { type: 'question', sampleId: 'P-0001' }),
        f(2, { type: 'blocker', sampleId: 'P-0002' }),
        f(3, { type: 'critical', sampleId: 'P-0002' }),
      ],
      TYPES_MAP
    )
    const agg = rollupForSamples(map, ['P-0001', 'P-0002'])
    expect(agg.count).toBe(3)
    expect(agg.dominantType).toBe('blocker')
    expect(agg.dominantColor).toBe('#e5484d')
  })

  it('returns an empty rollup for samples with no flags', () => {
    const map = buildRollupMap([f(1, { sampleId: 'P-0001' })], TYPES_MAP)
    const agg = rollupForSamples(map, ['P-9998', 'P-9999'])
    expect(agg.count).toBe(0)
    expect(agg.flags).toEqual([])
    expect(agg.dominantType).toBeNull()
  })

  it('dedupes repeated sample ids so a flag is not double-counted', () => {
    const map = buildRollupMap([f(1, { sampleId: 'P-0001' })], TYPES_MAP)
    const agg = rollupForSamples(map, ['P-0001', 'P-0001'])
    expect(agg.count).toBe(1)
  })
})

describe('useOpenFlagsBySample', () => {
  it('fetches the all_open list and exposes the map + a bound rollupForSamples', () => {
    useFlagsList.mockReturnValue({
      data: [
        f(1, { type: 'blocker', sampleId: 'P-0001' }),
        f(2, { type: 'question', sampleId: 'P-0002' }),
      ],
    })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const { result } = renderHook(() => useOpenFlagsBySample(), {
      wrapper: makeWrapper(qc),
    })

    expect(useFlagsList).toHaveBeenCalledWith('all_open')
    expect(result.current.map.get('P-0001')?.dominantType).toBe('blocker')
    expect(result.current.rollupForSamples(['P-0001', 'P-0002']).count).toBe(2)
    qc.clear()
  })
})
