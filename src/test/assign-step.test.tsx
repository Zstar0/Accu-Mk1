import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { AssignStep, bucketToAssignment } from '@/components/intake/ReceiveWizard/AssignStep'
import type { VialPlanResponse } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getVialPlan: vi.fn(),
    patchVialAssignment: vi.fn(),
    updateSenaiteSampleFields: vi.fn(),
    putVarianceOverride: vi.fn(),
  }
})

import { getVialPlan, patchVialAssignment, putVarianceOverride } from '@/lib/api'

const PLAN: VialPlanResponse = {
  demand: { hplc: 1, endo: 0, ster: 0 },
  variance: { hplc: 0, endo: 0, ster: 0 },
  base_demand: { hplc: 1, endo: 0, ster: 0 },
  wp_order_number: null,
  is_unreachable: false,
  vials: [
    { sample_id: 'P-0144', is_parent: true, vial_sequence: 0, assignment_role: 'hplc' },
    { sample_id: 'P-0144-S01', is_parent: false, vial_sequence: 1, assignment_role: 'hplc' },
  ],
}

const VARIANCE_PLAN: VialPlanResponse = {
  // NEW backend contract (Task 4): demand = base demand (not inflated),
  // variance is the separate paid-count map.
  demand: { hplc: 1, endo: 1, ster: 0 },
  variance: { hplc: 3, endo: 2, ster: 0 },
  base_demand: { hplc: 1, endo: 1, ster: 0 },
  wp_order_number: null,
  is_unreachable: false,
  vials: [
    { sample_id: 'P-0144', is_parent: true, vial_sequence: 0, assignment_role: 'hplc', assignment_kind: 'core' },
    { sample_id: 'P-0144-S01', is_parent: false, vial_sequence: 1, assignment_role: 'hplc', assignment_kind: 'core' },
    { sample_id: 'P-0144-S02', is_parent: false, vial_sequence: 2, assignment_role: 'hplc', assignment_kind: 'variance' },
    { sample_id: 'P-0144-S03', is_parent: false, vial_sequence: 3, assignment_role: 'endo', assignment_kind: 'core' },
    { sample_id: 'P-0144-S04', is_parent: false, vial_sequence: 4, assignment_role: 'endo', assignment_kind: 'variance' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getVialPlan).mockResolvedValue(PLAN)
  vi.mocked(patchVialAssignment).mockResolvedValue({
    sample_id: 'P-0144-S01',
    assignment_role: null,
  })
  vi.mocked(putVarianceOverride).mockResolvedValue({ variance: {} })
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

describe('bucketToAssignment', () => {
  it('maps variance buckets to (role, variance)', () => {
    expect(bucketToAssignment('hplc_variance')).toEqual({ role: 'hplc', kind: 'variance' })
    expect(bucketToAssignment('endo_variance')).toEqual({ role: 'endo', kind: 'variance' })
    expect(bucketToAssignment('ster_variance')).toEqual({ role: 'ster', kind: 'variance' })
  })
  it('maps core buckets to (role, core)', () => {
    expect(bucketToAssignment('hplc')).toEqual({ role: 'hplc', kind: 'core' })
    expect(bucketToAssignment('endo')).toEqual({ role: 'endo', kind: 'core' })
  })
  it('maps xtra to (xtra, null)', () => {
    expect(bucketToAssignment('xtra')).toEqual({ role: 'xtra', kind: null })
  })
})

describe('variance drop zones', () => {
  it('renders an HPLC Variance zone with the paid-count marker', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(VARIANCE_PLAN)
    renderStep()
    expect(await screen.findByText(/HPLC Variance/i)).toBeInTheDocument()
    expect(screen.getByText(/paid 3/i)).toBeInTheDocument()
  })

  it('renders no HPLC Variance zone when variance is zero', async () => {
    renderStep()  // default PLAN fixture (variance all zeros)
    await screen.findByText('P-0144-S01')
    expect(screen.queryByText(/HPLC Variance/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/paid/i)).not.toBeInTheDocument()
  })
})

describe('variance HPLC bucket pill', () => {
  it('renders Variance ×N on the HPLC bucket header when hplc variance >= 2', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(VARIANCE_PLAN)
    renderStep()
    expect(await screen.findByText('Variance ×3')).toBeInTheDocument()
  })
  it('no HPLC bucket pill when no variance', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(PLAN)
    renderStep()
    await screen.findByText('Analyses Dept.')
    expect(screen.queryByText(/Variance ×/)).not.toBeInTheDocument()
  })
})

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

describe('VarianceOverrideEditor', () => {
  it('renders an SLA-style help tooltip trigger explaining the count semantics', async () => {
    renderStep()
    await screen.findByText('P-0144-S01')
    // Radix tooltip content portals only on hover (jsdom-unfriendly, same as
    // the SLA cell tests) — assert the durable trigger contract.
    const trigger = screen.getByLabelText('What does the variance count mean?')
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveAttribute('data-slot', 'tooltip-trigger')
  })

  it('renders with HPLC input prefilled from plan.variance', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(VARIANCE_PLAN)
    renderStep()
    await screen.findByText('P-0144-S01')
    const hplcInput = screen.getByRole('spinbutton', { name: /variance hplc/i })
    expect(hplcInput).toHaveValue(3)
  })

  it('changing HPLC to 4 + Save calls putVarianceOverride and re-fetches plan', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(VARIANCE_PLAN)
    vi.mocked(putVarianceOverride).mockResolvedValue({ variance: { hplcpurity_identity: 4, endotoxin: 2 } })
    renderStep()
    await screen.findByText('P-0144-S01')

    const hplcInput = screen.getByRole('spinbutton', { name: /variance hplc/i })
    await userEvent.clear(hplcInput)
    await userEvent.type(hplcInput, '4')

    await userEvent.click(screen.getByRole('button', { name: /save variance/i }))

    await waitFor(() => {
      expect(putVarianceOverride).toHaveBeenCalledWith(
        'P-0144',
        expect.objectContaining({ hplcpurity_identity: 4, endotoxin: 2 }),
      )
    })
    // getVialPlan should have been called a second time (refresh after save)
    await waitFor(() => {
      expect(getVialPlan).toHaveBeenCalledTimes(2)
    })
  })

  it('setting all to 0 + Save calls putVarianceOverride with null', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(VARIANCE_PLAN)
    vi.mocked(putVarianceOverride).mockResolvedValue({ variance: {} })
    renderStep()
    await screen.findByText('P-0144-S01')

    // Clear HPLC (was 3)
    const hplcInput = screen.getByRole('spinbutton', { name: /variance hplc/i })
    await userEvent.clear(hplcInput)
    await userEvent.type(hplcInput, '0')

    // Clear Endo (was 2)
    const endoInput = screen.getByRole('spinbutton', { name: /variance endo/i })
    await userEvent.clear(endoInput)
    await userEvent.type(endoInput, '0')

    await userEvent.click(screen.getByRole('button', { name: /save variance/i }))

    await waitFor(() => {
      expect(putVarianceOverride).toHaveBeenCalledWith('P-0144', null)
    })
  })
})
