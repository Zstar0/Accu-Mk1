// Task 13 (spec 4, catalog-driven bench): the FE half of the spec's
// headline acceptance promise — "new department + new profile via API
// only -> assignment page shows the new section and spot with zero code
// changes." This is a FIXTURE-level proof: it feeds AssignStep a
// VialPlanResponse shaped exactly like the backend acceptance test's own
// department ('ZZ Bench') / role ('zz_acc') / profile ('ZZ Acceptance')
// naming (backend/tests/test_catalog_bench_acceptance.py), never touching
// AssignStep.tsx itself — proving the render path is genuinely data-driven,
// not a hardcoded allow-list. (assign-step.test.tsx's T_ROLE_PLAN case
// already covers this generically for Task 9; this file names it after the
// spec's own acceptance fixture, as the dedicated headline proof Task 13's
// brief calls for.)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AssignStep } from '@/components/intake/ReceiveWizard/AssignStep'
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

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import { getVialPlan, patchVialAssignment, putVarianceOverride } from '@/lib/api'

// Mirrors the backend acceptance test's exact shapes: department "ZZ
// Bench", role code "zz_acc" (never in ROLE_SHORT_DEFAULTS, so its chip
// falls back to the uppercased code), profile "ZZ Acceptance" as host.
const ZZ_BENCH_PLAN: VialPlanResponse = {
  demand: { hplc: 0, endo: 0, ster: 0, zz_acc: 1 },
  variance: { hplc: 0, endo: 0, ster: 0 },
  base_demand: { hplc: 0, endo: 0, ster: 0, zz_acc: 1 },
  wp_order_number: null,
  is_unreachable: false,
  sections: [
    {
      department_id: 99, department_name: 'ZZ Bench', sort_order: 99,
      roles: [
        {
          code: 'zz_acc', label: 'ZZ Acceptance', sort_order: 0, variance_eligible: false,
          profiles: [{ id: 1, key: 'zz_accept', name: 'ZZ Acceptance', relation: 'host' as const }],
        },
      ],
    },
  ],
  vials: [
    { sample_id: 'ZZACC-0001-S01', is_parent: false, vial_sequence: 1, assignment_role: 'zz_acc', assignment_kind: 'core' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getVialPlan).mockResolvedValue(ZZ_BENCH_PLAN)
  vi.mocked(patchVialAssignment).mockResolvedValue({
    sample_id: 'ZZACC-0001-S01',
    assignment_role: null,
  })
  vi.mocked(putVarianceOverride).mockResolvedValue({ variance: {} })
})

function renderStep() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <AssignStep parentSampleId="ZZACC-0001" parentSampleUid="uid-zzacc" />
    </QueryClientProvider>
  )
}

describe('AssignStep — manager authors, lab follows (fixture-level acceptance)', () => {
  it('renders the new department section, its spot, and the assigned vial with zero code changes', async () => {
    renderStep()

    // Section = the new department's real name — no literal for "ZZ Bench"
    // exists anywhere in AssignStep.tsx.
    expect(await screen.findByText('ZZ Bench')).toBeInTheDocument()

    // The vial carrying the new role lands inside that section (not Xtra),
    // and demand is met (1 / 1) — both are pure catalog reads.
    expect(screen.getByText('ZZACC-0001-S01')).toBeInTheDocument()
    expect(screen.getByText('1 / 1')).toBeInTheDocument()

    // Its chip badge falls back to the uppercased role code (roleShort's
    // documented fallback for any code outside ROLE_SHORT_DEFAULTS) — proof
    // this is the generic path, not a hardcoded literal for 'zz_acc'.
    expect(screen.getByText('ZZ_ACC')).toBeInTheDocument()

    // Xtra always renders too, but never claims this vial.
    const xtraBucket = screen.getByText('Xtra').closest('div.border-2')
    expect(xtraBucket).not.toBeNull()
    expect(xtraBucket?.textContent).not.toContain('ZZACC-0001-S01')
  })
})
