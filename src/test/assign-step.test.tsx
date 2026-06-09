import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { AssignStep } from '@/components/intake/ReceiveWizard/AssignStep'
import type { VialPlanResponse } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getVialPlan: vi.fn(),
    patchVialAssignment: vi.fn(),
    updateSenaiteSampleFields: vi.fn(),
  }
})

import { getVialPlan, patchVialAssignment } from '@/lib/api'

const PLAN: VialPlanResponse = {
  demand: { hplc: 1, endo: 0, ster: 0 },
  wp_order_number: null,
  is_unreachable: false,
  vials: [
    { sample_id: 'P-0144', is_parent: true, vial_sequence: 0, assignment_role: 'hplc' },
    { sample_id: 'P-0144-S01', is_parent: false, vial_sequence: 1, assignment_role: 'hplc' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getVialPlan).mockResolvedValue(PLAN)
  vi.mocked(patchVialAssignment).mockResolvedValue({
    sample_id: 'P-0144-S01',
    assignment_role: null,
  })
})

/** Probes simulating the parent sample-details page's cached queries.
 *  Keys are literals on purpose — they lock the cross-component contract. */
function renderStep() {
  const subsFn = vi.fn(async () => ({}))
  const overlayFn = vi.fn(async () => [])
  function Probes() {
    useQuery({ queryKey: ['sub-samples', 'P-0144'], queryFn: subsFn, staleTime: Infinity })
    useQuery({ queryKey: ['parent-overlay-vial-analyses', 21], queryFn: overlayFn, staleTime: Infinity })
    return null
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <Probes />
      <AssignStep parentSampleId="P-0144" parentSampleUid="uid-1" />
    </QueryClientProvider>
  )
  return { subsFn, overlayFn }
}

describe('AssignStep role-change cache invalidation', () => {
  it('reset bucket: patches each vial to null and refetches the parent page caches', async () => {
    const { subsFn, overlayFn } = renderStep()
    // steady state: plan loaded, both probes fetched once
    await screen.findByText('P-0144-S01')
    await waitFor(() => {
      expect(subsFn).toHaveBeenCalledTimes(1)
      expect(overlayFn).toHaveBeenCalledTimes(1)
    })

    await userEvent.click(screen.getByRole('button', { name: /reset/i }))

    await waitFor(() => {
      expect(patchVialAssignment).toHaveBeenCalledWith('P-0144-S01', null)
    })
    // staleTime Infinity → only an explicit invalidation can refetch the probes
    await waitFor(() => {
      expect(subsFn).toHaveBeenCalledTimes(2)
      expect(overlayFn).toHaveBeenCalledTimes(2)
    })
  })
})
