import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { AssignStep, bucketToAssignment, toastAssignmentError } from '@/components/intake/ReceiveWizard/AssignStep'
import type { VialPlanResponse } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getVialPlan: vi.fn(),
    patchVialAssignment: vi.fn(),
    updateSenaiteSampleFields: vi.fn(),
    putVarianceOverride: vi.fn(),
    // S1 roles-as-data: AssignStep now calls useVialRoles(); without this the
    // real fetcher would fire a real network call on every render. Resolves
    // empty so roleShortLabel/roleFullLabel take the same uppercased-code
    // fallback the unmocked fetch's failure produced before — every
    // fixture-role assertion below (HM, T_ROLE, etc.) is unchanged.
    getVialRoles: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import { ApiCodeError, getVialPlan, getVialRoles, patchVialAssignment, putVarianceOverride } from '@/lib/api'
import { toast } from 'sonner'

// Section fixtures mirror the real shape emitted by
// backend/sub_samples/service.py::_build_vial_plan_sections (Task 8) — see
// TestVialPlanSections in backend/tests/test_sub_samples_routes.py for the
// canonical department names ('Analytical', 'Microbiology', 'Heavy Metals')
// and role labels ('HPLC', 'Endotoxin', 'Sterility', 'Heavy Metals') seeded
// by backend/catalog/vial_roles_seed.py.
const ANALYTICAL_HPLC_SECTION = {
  department_id: 1,
  department_name: 'Analytical',
  sort_order: 0,
  roles: [
    {
      code: 'hplc', label: 'HPLC', sort_order: 0, variance_eligible: true,
      profiles: [{ id: 1, key: 'hplcpurity_identity', name: 'HPLC Purity & Identity', relation: 'host' as const }],
    },
  ],
}

const PLAN: VialPlanResponse = {
  demand: { hplc: 1, endo: 0, ster: 0 },
  variance: { hplc: 0, endo: 0, ster: 0 },
  base_demand: { hplc: 1, endo: 0, ster: 0 },
  wp_order_number: null,
  is_unreachable: false,
  sections: [ANALYTICAL_HPLC_SECTION],
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
  sections: [
    ANALYTICAL_HPLC_SECTION,
    {
      department_id: 2, department_name: 'Microbiology', sort_order: 1,
      // endo-only: ster has no demand and no carried vial in this fixture,
      // so the backend never mints a ster spot — a single-role Microbiology
      // section renders through the same direct-drop Bucket path as HPLC.
      roles: [
        {
          code: 'endo', label: 'Endotoxin', sort_order: 1, variance_eligible: true,
          profiles: [{ id: 2, key: 'endotoxin', name: 'Endotoxin', relation: 'host' as const }],
        },
      ],
    },
  ],
  vials: [
    { sample_id: 'P-0144', is_parent: true, vial_sequence: 0, assignment_role: 'hplc', assignment_kind: 'core' },
    { sample_id: 'P-0144-S01', is_parent: false, vial_sequence: 1, assignment_role: 'hplc', assignment_kind: 'core' },
    { sample_id: 'P-0144-S02', is_parent: false, vial_sequence: 2, assignment_role: 'hplc', assignment_kind: 'variance' },
    { sample_id: 'P-0144-S03', is_parent: false, vial_sequence: 3, assignment_role: 'endo', assignment_kind: 'core' },
    { sample_id: 'P-0144-S04', is_parent: false, vial_sequence: 4, assignment_role: 'endo', assignment_kind: 'variance' },
  ],
}

const CONTAINER_PLAN: VialPlanResponse = {
  // Container family: parent is a pure depository — no parent entry in
  // vials, core demand filled by physical sub-samples (S01 IS Vial 1).
  demand: { hplc: 1, endo: 0, ster: 0 },
  variance: { hplc: 0, endo: 0, ster: 0 },
  base_demand: { hplc: 1, endo: 0, ster: 0 },
  wp_order_number: null,
  is_unreachable: false,
  container_mode: true,
  sections: [ANALYTICAL_HPLC_SECTION],
  vials: [
    { sample_id: 'P-0144-S01', is_parent: false, vial_sequence: 1, assignment_role: 'hplc', assignment_kind: 'core' },
    { sample_id: 'P-0144-S02', is_parent: false, vial_sequence: 2, assignment_role: null, assignment_kind: null },
  ],
}

// Full legacy hplc+endo+ster plan — the PIXEL-PARITY reference shape: a
// three-role plan whose Microbiology department carries BOTH endo and ster,
// exercising the multi-role (SubDropZone) section path exactly like today's
// hardcoded MicroBucket. Endo's spot also carries a rider profile to prove
// the rider-chip contract (spec 4, Task 8's host/rider relation).
const FULL_PLAN: VialPlanResponse = {
  demand: { hplc: 1, endo: 1, ster: 1 },
  variance: { hplc: 0, endo: 0, ster: 0 },
  base_demand: { hplc: 1, endo: 1, ster: 1 },
  wp_order_number: null,
  is_unreachable: false,
  sections: [
    ANALYTICAL_HPLC_SECTION,
    {
      department_id: 2, department_name: 'Microbiology', sort_order: 1,
      roles: [
        {
          code: 'endo', label: 'Endotoxin', sort_order: 1, variance_eligible: true,
          profiles: [
            { id: 2, key: 'endotoxin', name: 'Endotoxin', relation: 'host' as const },
            { id: 3, key: 'zztest_rides_endo', name: 'ZZTEST Rider', relation: 'rider' as const },
          ],
        },
        {
          code: 'ster', label: 'Sterility', sort_order: 2, variance_eligible: true,
          profiles: [{ id: 4, key: 'sterility_pcr', name: 'Sterility PCR', relation: 'host' as const }],
        },
      ],
    },
  ],
  vials: [
    { sample_id: 'P-0144', is_parent: true, vial_sequence: 0, assignment_role: 'hplc', assignment_kind: 'core' },
    { sample_id: 'P-0144-S01', is_parent: false, vial_sequence: 1, assignment_role: 'hplc', assignment_kind: 'core' },
    { sample_id: 'P-0144-S02', is_parent: false, vial_sequence: 2, assignment_role: 'endo', assignment_kind: 'core' },
    { sample_id: 'P-0144-S03', is_parent: false, vial_sequence: 3, assignment_role: 'ster', assignment_kind: 'core' },
  ],
}

// The hm-invisibility regression: pre-Task-9 AssignStep only ever rendered
// hplc/endo/ster/xtra buckets, so an hm-role vial matched NO filter and
// simply never appeared anywhere in the DOM. A catalog section now exists
// for it, so it must render, visibly, under its own department.
const HM_PLAN: VialPlanResponse = {
  demand: { hplc: 0, endo: 0, ster: 0, hm: 1 },
  variance: { hplc: 0, endo: 0, ster: 0 },
  base_demand: { hplc: 0, endo: 0, ster: 0, hm: 1 },
  wp_order_number: null,
  is_unreachable: false,
  sections: [
    {
      department_id: 3, department_name: 'Heavy Metals', sort_order: 3,
      roles: [
        {
          code: 'hm', label: 'Heavy Metals', sort_order: 3, variance_eligible: false,
          profiles: [{ id: 5, key: 'zztest_heavy_metals', name: 'ZZTEST Heavy Metals', relation: 'host' as const }],
        },
      ],
    },
  ],
  vials: [
    { sample_id: 'P-0144-S01', is_parent: false, vial_sequence: 1, assignment_role: 'hm', assignment_kind: 'core' },
  ],
}

// A wholly novel catalog role/department the FE has never seen a literal
// for — proves the render path is genuinely data-driven, not a hardcoded
// allow-list with one extra case bolted on.
const T_ROLE_PLAN: VialPlanResponse = {
  demand: { hplc: 0, endo: 0, ster: 0, t_role: 1 },
  variance: { hplc: 0, endo: 0, ster: 0 },
  base_demand: { hplc: 0, endo: 0, ster: 0, t_role: 1 },
  wp_order_number: null,
  is_unreachable: false,
  sections: [
    {
      department_id: 9, department_name: 'T Dept', sort_order: 9,
      roles: [
        { code: 't_role', label: 'T Role', sort_order: 0, variance_eligible: false, profiles: [] },
      ],
    },
  ],
  vials: [
    { sample_id: 'P-0144-S01', is_parent: false, vial_sequence: 1, assignment_role: 't_role', assignment_kind: 'core' },
  ],
}

// A vial carrying a role code that appears in NO section — the registry-
// unknown-role case (_build_vial_plan_sections logs + excludes it
// server-side). Must still render, visibly, in Xtra — never silently drop.
const UNKNOWN_ROLE_PLAN: VialPlanResponse = {
  ...PLAN,
  vials: [
    ...PLAN.vials,
    { sample_id: 'P-0144-S02', is_parent: false, vial_sequence: 2, assignment_role: 'zzghost', assignment_kind: 'core' },
  ],
}

// An admin flips variance_eligible off for a role (main.py PATCH
// /vial-roles/{id} — the flag, unlike the row itself, isn't frozen) AFTER a
// vial was already assigned assignment_kind='variance' under it. The zone
// must still surface that stored vial — gating the whole zone on
// variance_eligible would make it invisible, the same class of bug as hm.
const VARIANCE_INELIGIBLE_STORED_PLAN: VialPlanResponse = {
  demand: { hplc: 1, endo: 0, ster: 0 },
  variance: { hplc: 0, endo: 0, ster: 0 },
  base_demand: { hplc: 1, endo: 0, ster: 0 },
  wp_order_number: null,
  is_unreachable: false,
  sections: [
    {
      department_id: 1, department_name: 'Analytical', sort_order: 0,
      roles: [
        {
          code: 'hplc', label: 'HPLC', sort_order: 0, variance_eligible: false,
          profiles: [{ id: 1, key: 'hplcpurity_identity', name: 'HPLC Purity & Identity', relation: 'host' as const }],
        },
      ],
    },
  ],
  vials: [
    { sample_id: 'P-0144', is_parent: true, vial_sequence: 0, assignment_role: 'hplc', assignment_kind: 'core' },
    { sample_id: 'P-0144-S01', is_parent: false, vial_sequence: 1, assignment_role: 'hplc', assignment_kind: 'core' },
    { sample_id: 'P-0144-S02', is_parent: false, vial_sequence: 2, assignment_role: 'hplc', assignment_kind: 'variance' },
  ],
}

// IS-unreachable: sections is always [] on this path (Task 8 contract).
// Every carried real role has nowhere to land but Xtra.
const UNREACHABLE_PLAN: VialPlanResponse = {
  demand: { hplc: 0, endo: 0, ster: 0 },
  variance: { hplc: 0, endo: 0, ster: 0 },
  base_demand: { hplc: 0, endo: 0, ster: 0 },
  wp_order_number: null,
  is_unreachable: true,
  sections: [],
  vials: [
    { sample_id: 'P-0144', is_parent: true, vial_sequence: 0, assignment_role: 'hplc', assignment_kind: null },
    { sample_id: 'P-0144-S01', is_parent: false, vial_sequence: 1, assignment_role: 'hplc', assignment_kind: 'core' },
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
  vi.mocked(getVialRoles).mockResolvedValue([])
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

  it('renders an Endo Variance zone when endo variance is purchased', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(VARIANCE_PLAN)  // endo variance 2
    renderStep()
    expect(await screen.findByText(/Endo Variance/i)).toBeInTheDocument()
  })

  it('shows the HPLC Variance zone for a minimum upsell (1 paid replicate)', async () => {
    // plan.variance is the PAID REPLICATE count (total − 1), so a 2-total upsell
    // is variance.hplc=1. The zone must reveal at >0 — gating on >=2 would hide
    // the single-replicate case, which is the common lab upsell.
    vi.mocked(getVialPlan).mockResolvedValue({
      ...PLAN,
      variance: { hplc: 1, endo: 0, ster: 0 },
    })
    renderStep()
    expect(await screen.findByText(/HPLC Variance/i)).toBeInTheDocument()
    expect(screen.getByText(/paid 1/i)).toBeInTheDocument()
  })

  it('hides the HPLC Variance zone when the order has no variance', async () => {
    // Spec change (2026-06-16): the variance drop zone is entitlement-gated —
    // hidden unless there is at least one paid variance replicate (plan.variance
    // > 0, i.e. the lab set a total ≥2 in the Variance Testing box). Rationale:
    // an always-on zone nested inside the core bucket let a vial dragged back
    // into HPLC land on variance by accident (BW-0015 bug). Setting the total in
    // the Variance Testing box turns variance ON and reveals the zone.
    renderStep()  // default PLAN fixture (variance all zeros)
    await screen.findByText('P-0144-S01')
    expect(screen.queryByText(/HPLC Variance/i)).not.toBeInTheDocument()
  })
})

describe('variance_locked 409 handling', () => {
  it('routes a code=variance_locked rejection to the distinct lock toast', async () => {
    // Real 409 error shape thrown by patchVialAssignment:
    // detail = { code: 'variance_locked', message: 'variance set for ... is locked; ...' }
    const lockErr = new ApiCodeError(
      'variance set for P-0144 is locked; unlock before re-assigning vials',
      'variance_locked',
    )
    vi.mocked(patchVialAssignment).mockRejectedValue(lockErr)

    // Same flow as handleDragEnd: the PATCH rejection is caught and routed
    // through toastAssignmentError (drag itself isn't jsdom-simulable).
    const caught = await patchVialAssignment('P-0144-S02', 'hplc', 'variance').catch(e => e)
    toastAssignmentError(caught)

    expect(toast.error).toHaveBeenCalledWith(
      'Variance assignment locked',
      expect.objectContaining({ description: expect.stringMatching(/locked/i) }),
    )
  })

  it('routes other failures to the generic assignment-failed toast', () => {
    toastAssignmentError(new Error('network down'))
    expect(toast.error).toHaveBeenCalledWith(
      'Assignment failed',
      expect.objectContaining({ description: 'network down' }),
    )
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
    await screen.findByText('Analytical')
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

describe('container mode', () => {
  it('renders no parent chip — only sub-sample vials', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(CONTAINER_PLAN)
    renderStep()
    // step rendered (HPLC bucket present). CONTAINER_PLAN has no variance, so
    // the variance zone is gated off — assert on the core bucket label instead.
    expect(await screen.findByText('Analytical')).toBeInTheDocument()
    // S01 chip present; the bare parent id is NOT rendered as a vial chip
    expect(screen.getByText('P-0144-S01')).toBeInTheDocument()
    expect(screen.queryByText(/^P-0144$/)).not.toBeInTheDocument()
  })
})

describe('catalog-driven sections (Task 9)', () => {
  it('renders a Heavy Metals section from an hm role spot — the hm vial is visible and labeled HM (invisibility regression)', async () => {
    // Pre-Task-9 AssignStep only filtered hplc/endo/ster/xtra — an hm-role
    // vial matched none of those and rendered nowhere. This is the fix.
    vi.mocked(getVialPlan).mockResolvedValue(HM_PLAN)
    renderStep()
    expect(await screen.findByText('Heavy Metals')).toBeInTheDocument()
    expect(screen.getByText('P-0144-S01')).toBeInTheDocument()
    expect(screen.getByText('HM')).toBeInTheDocument()
  })

  it('renders the full hplc+endo+ster legacy plan with pixel-parity dept headers and catalog role labels', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(FULL_PLAN)
    renderStep()
    expect(await screen.findByText('Analytical')).toBeInTheDocument()
    expect(screen.getByText('Microbiology')).toBeInTheDocument()
    // Deliberate display delta (signed off): sub-zone labels are now the
    // catalog role label ('Endotoxin'/'Sterility'), not the old short forms.
    // (Matched with the ' ·' suffix — VarianceOverrideEditor unconditionally
    // renders its own plain 'Sterility'/'Endo' input labels below the grid.)
    expect(screen.getByText(/Endotoxin ·/)).toBeInTheDocument()
    expect(screen.getByText(/Sterility ·/)).toBeInTheDocument()
  })

  it('renders a rider chip on its host role spot, distinct from a drop target', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(FULL_PLAN)
    renderStep()
    await screen.findByText('Microbiology')
    expect(screen.getByText('ZZTEST Rider')).toBeInTheDocument()
    expect(screen.getByText(/· rider/)).toBeInTheDocument()
  })

  it('renders the rider chip landing vial when host_vials is present (spec 2026-08-20-rider-vial-visibility)', async () => {
    const plan: VialPlanResponse = JSON.parse(JSON.stringify(FULL_PLAN))
    const endoRole = plan.sections[1]!.roles.find(r => r.code === 'endo')!
    const riderProfile = endoRole.profiles.find(p => p.relation === 'rider')!
    riderProfile.host_vials = ['P-0001-S01']
    vi.mocked(getVialPlan).mockResolvedValue(plan)
    renderStep()
    await screen.findByText('Microbiology')
    expect(await screen.findByText(/· rider → S01/)).toBeInTheDocument()
  })

  it('round-trips a novel role (t_role): renders its section+spot, is a valid drag target, chip falls back to the uppercased code', async () => {
    expect(bucketToAssignment('t_role')).toEqual({ role: 't_role', kind: 'core' })
    vi.mocked(getVialPlan).mockResolvedValue(T_ROLE_PLAN)
    renderStep()
    expect(await screen.findByText('T Dept')).toBeInTheDocument()
    expect(screen.getByText('P-0144-S01')).toBeInTheDocument()
    expect(screen.getByText('T_ROLE')).toBeInTheDocument()
  })

  it('a vial whose role appears in no section lands visibly in Xtra (registry-unknown role never invisible)', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(UNKNOWN_ROLE_PLAN)
    renderStep()
    await screen.findByText('P-0144-S01')
    const xtraBucket = screen.getByText('Xtra').closest('div.border-2')
    expect(xtraBucket).not.toBeNull()
    expect(within(xtraBucket as HTMLElement).getByText('P-0144-S02')).toBeInTheDocument()
  })

  it('is_unreachable plan (sections: []) still renders every carried-role vial, landing in Xtra', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(UNREACHABLE_PLAN)
    renderStep()
    expect(await screen.findByText(/Couldn't load order services/)).toBeInTheDocument()
    const xtraBucket = screen.getByText('Xtra').closest('div.border-2')
    expect(xtraBucket).not.toBeNull()
    expect(within(xtraBucket as HTMLElement).getByText('P-0144-S01')).toBeInTheDocument()
  })

  it('a stored variance vial still renders even when its role is not (or no longer) variance_eligible (never invisible)', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(VARIANCE_INELIGIBLE_STORED_PLAN)
    renderStep()
    expect(await screen.findByText('P-0144-S02')).toBeInTheDocument()
  })

  it('section grid wraps responsively instead of cutting columns off on narrow viewports', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(FULL_PLAN)
    renderStep()
    await screen.findByText('Analytical')
    const grid = screen.getByText('Xtra').closest('div.border-2')?.parentElement
    expect(grid).not.toBeNull()
    expect((grid as HTMLElement).style.gridTemplateColumns).toContain('auto-fit')
    expect((grid as HTMLElement).style.gridTemplateColumns).toContain('minmax')
  })
})

describe('vial-roles loading gate (fix round 1)', () => {
  it('holds the loading state until the vial-roles catalog resolves, even once the plan has loaded', async () => {
    // The plan resolves immediately; the catalog stays pending — the section
    // content (which would render roleShort off a cold/undefined cache) must
    // not appear until both queries have settled.
    let resolveRoles!: (rows: Awaited<ReturnType<typeof getVialRoles>>) => void
    vi.mocked(getVialRoles).mockImplementation(() => new Promise(r => { resolveRoles = r }))
    renderStep()

    // Give the plan fetch a tick to resolve — still no section content, because
    // the vial-roles gate is still pending.
    await waitFor(() => expect(getVialPlan).toHaveBeenCalled())
    expect(screen.queryByText('Analytical')).not.toBeInTheDocument()

    resolveRoles([])
    expect(await screen.findByText('Analytical')).toBeInTheDocument()
  })
})
