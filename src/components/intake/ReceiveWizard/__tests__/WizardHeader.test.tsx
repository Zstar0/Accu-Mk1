import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import { getVialDemand, type VialDemandResponse } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  getVialDemand: vi.fn(),
}))

import { WizardHeader } from '@/components/intake/ReceiveWizard/WizardHeader'

const mockGetVialDemand = vi.mocked(getVialDemand)

function demand(overrides: Partial<VialDemandResponse> = {}): VialDemandResponse {
  return {
    demand: { hplc: 0, endo: 0, ster: 0 },
    variance: { hplc: 0, endo: 0, ster: 0 },
    base_demand: { hplc: 0, endo: 0, ster: 0 },
    wp_order_number: 'WP-1',
    is_unreachable: false,
    ...overrides,
  }
}

// The header renders "{total} vial(s) ({breakdown})" as sibling/nested text
// nodes, so RTL's getByText can match both the outer and inner span for an
// overlapping substring. Asserting against the container's full text avoids
// that ambiguity entirely.
function renderHeader(receivedCount = 0) {
  return render(<WizardHeader parentSampleId="P-1" receivedCount={receivedCount} />)
}

describe('WizardHeader — shape-driven expected-vials total', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sums the legacy hplc/endo/ster buckets as before (no hm on this order)', async () => {
    mockGetVialDemand.mockResolvedValue(demand({ demand: { hplc: 2, endo: 1, ster: 2 } }))
    const { container } = renderHeader()
    await waitFor(() => expect(container.textContent).toContain('5 vials'))
    expect(container.textContent).toContain('(2 HPLC · 1 ENDO · 2 STERYL)')
  })

  it('includes the hm bucket in the total and breakdown — regression guard for the capture-step undercount', async () => {
    // An HM+legacy order: hplc:1, endo:1, ster:2, hm:1 must total 5, not 4.
    mockGetVialDemand.mockResolvedValue(
      demand({ demand: { hplc: 1, endo: 1, ster: 2, hm: 1 } }),
    )
    const { container } = renderHeader()
    await waitFor(() => expect(container.textContent).toContain('5 vials'))
    expect(container.textContent).toContain('(1 HPLC · 1 ENDO · 2 STERYL · 1 HM)')
  })

  it('adds variance vials for the hm bucket too, without pinning hm to zero variance', async () => {
    // hm is never variance-eligible in practice (Task 3), but the total/
    // breakdown math must not special-case that — it should just sum
    // whatever variance actually reports.
    mockGetVialDemand.mockResolvedValue(
      demand({
        demand: { hplc: 0, endo: 0, ster: 0, hm: 1 },
        variance: { hplc: 0, endo: 0, ster: 0 },
      }),
    )
    const { container } = renderHeader()
    await waitFor(() => expect(container.textContent).toContain('1 vial'))
    expect(container.textContent).toContain('(1 HM)')
  })

  it('falls back to the uppercased key for a future catalog-only bucket', async () => {
    mockGetVialDemand.mockResolvedValue(
      demand({ demand: { hplc: 0, endo: 0, ster: 0, future_role: 3 } }),
    )
    const { container } = renderHeader()
    await waitFor(() => expect(container.textContent).toContain('3 vials'))
    expect(container.textContent).toContain('(3 FUTURE_ROLE)')
  })

  it('shows "Order data unavailable" when the order lookup is unreachable', async () => {
    mockGetVialDemand.mockResolvedValue(demand({ is_unreachable: true }))
    renderHeader()
    await waitFor(() =>
      expect(screen.getByText('Order data unavailable — proceed manually')).toBeInTheDocument(),
    )
  })
})
