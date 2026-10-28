import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { NATIVE_PARENT_ANALYSES_QUERY_KEY } from '@/lib/native-parent-analyses'
import {
  PARENT_OVERLAY_QUERY_KEY,
  QUICKLOOK_VIAL_ANALYSES_QUERY_KEY,
} from '@/lib/vial-assignment'
import { sampleFormKeys, useSetSampleForm } from '@/services/sample-forms'

vi.mock('@/lib/api-sample-forms', async () => {
  const actual = (await vi.importActual('@/lib/api-sample-forms')) as Record<
    string,
    unknown
  >
  return {
    ...actual,
    setSampleForm: vi.fn(async () => ({
      sample_form_id: 4,
      sample_form_name: 'Nasal Spray',
      sample_form_eligible: true,
    })),
  }
})

describe('useSetSampleForm', () => {
  it('refetches every cached analyses listing once the form changes', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)
    const { result } = renderHook(() => useSetSampleForm(), { wrapper })

    result.current.mutate({ sampleId: 'P-0153', sampleFormId: 4 })

    // Units, the preset unit and the spec all follow the form: a closed Vials
    // Quick Look must not serve the old form's unit when it reopens.
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const keys = spy.mock.calls.map(c => c[0]?.queryKey)
    expect(keys).toEqual(
      expect.arrayContaining([
        sampleFormKeys.all,
        [PARENT_OVERLAY_QUERY_KEY],
        [QUICKLOOK_VIAL_ANALYSES_QUERY_KEY],
        [NATIVE_PARENT_ANALYSES_QUERY_KEY],
      ])
    )
  })
})
