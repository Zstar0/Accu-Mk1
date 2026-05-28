import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type * as ApiModule from '@/lib/api'

const updateSlaTierMock = vi.fn().mockResolvedValue({})
const setSlaPriorityTierMock = vi.fn().mockResolvedValue({})
const deleteSlaPriorityTierMock = vi.fn().mockResolvedValue(undefined)
// Per-test override hooks: each test can re-mock returned data shape.
const getSlaPriorityTiersMock = vi.fn().mockResolvedValue([])
const getServiceGroupsMock = vi.fn().mockResolvedValue([])
const getSlaTiersMock = vi.fn().mockResolvedValue([
  {
    id: 1,
    name: 'Standard',
    target_minutes: 1440,
    business_hours_only: false,
    is_default: true,
    amber_threshold_percent: 25,
    created_at: '2026-01-01T00:00:00',
    updated_at: '2026-01-01T00:00:00',
  },
])

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api')
  return {
    ...actual,
    getSlaTiers: () => getSlaTiersMock(),
    getSlaPriorityTiers: () => getSlaPriorityTiersMock(),
    getServiceGroups: () => getServiceGroupsMock(),
    updateSlaTier: (id: number, data: unknown) => updateSlaTierMock(id, data),
    createSlaTier: vi.fn(),
    deleteSlaTier: vi.fn(),
    setSlaPriorityTier: (
      priority: string,
      slaTierId: number,
      serviceGroupId?: number | null
    ) => setSlaPriorityTierMock(priority, slaTierId, serviceGroupId),
    deleteSlaPriorityTier: (priority: string, serviceGroupId?: number | null) =>
      deleteSlaPriorityTierMock(priority, serviceGroupId),
  }
})

vi.mock('@/store/auth-store', () => ({
  useAuthStore: <T,>(selector: (s: { user: { role: string } }) => T) =>
    selector({ user: { role: 'admin' } }),
}))

const { SlaPane } = await import('@/components/preferences/panes/SlaPane')

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  updateSlaTierMock.mockClear()
  setSlaPriorityTierMock.mockClear()
  deleteSlaPriorityTierMock.mockClear()
  // Reset queries to defaults so each test starts clean.
  getSlaPriorityTiersMock.mockReset().mockResolvedValue([])
  getServiceGroupsMock.mockReset().mockResolvedValue([])
  getSlaTiersMock.mockReset().mockResolvedValue([
    {
      id: 1,
      name: 'Standard',
      target_minutes: 1440,
      business_hours_only: false,
      is_default: true,
      amber_threshold_percent: 25,
      created_at: '2026-01-01T00:00:00',
      updated_at: '2026-01-01T00:00:00',
    },
  ])
})

describe('SlaPane — amber threshold input', () => {
  it('renders the amber input with the tier value and PUTs on blur', async () => {
    render(<SlaPane />, { wrapper })
    const input = await screen.findByTestId('sla-amber-input-1')
    expect((input as HTMLInputElement).value).toBe('25')
    fireEvent.change(input, { target: { value: '40' } })
    fireEvent.blur(input)
    await waitFor(() => {
      expect(updateSlaTierMock).toHaveBeenCalled()
    })
    const firstCall = updateSlaTierMock.mock.calls[0]
    expect(firstCall).toBeDefined()
    const payload = firstCall?.[1]
    expect(payload).toMatchObject({ amber_threshold_percent: 40 })
  })

  it('blur with an unchanged value does NOT call updateSlaTier', async () => {
    render(<SlaPane />, { wrapper })
    const input = await screen.findByTestId('sla-amber-input-1')
    fireEvent.blur(input)
    expect(updateSlaTierMock).not.toHaveBeenCalled()
  })

  it('rejects invalid input "abc" and snaps the input back to the persisted value', async () => {
    render(<SlaPane />, { wrapper })
    const input = await screen.findByTestId('sla-amber-input-1') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)
    expect(updateSlaTierMock).not.toHaveBeenCalled()
    expect(input.value).toBe('25')
  })

  it('rejects out-of-range "0" and "101" and snaps back', async () => {
    render(<SlaPane />, { wrapper })
    const input = await screen.findByTestId('sla-amber-input-1') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(updateSlaTierMock).not.toHaveBeenCalled()
    expect(input.value).toBe('25')
    fireEvent.change(input, { target: { value: '101' } })
    fireEvent.blur(input)
    expect(updateSlaTierMock).not.toHaveBeenCalled()
    expect(input.value).toBe('25')
  })

  it('accepts boundary "1" and "100"', async () => {
    render(<SlaPane />, { wrapper })
    const input = await screen.findByTestId('sla-amber-input-1') as HTMLInputElement
    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.blur(input)
    await waitFor(() => expect(updateSlaTierMock).toHaveBeenCalled())
    const firstCall = updateSlaTierMock.mock.calls[0]
    expect(firstCall).toBeDefined()
    expect(firstCall?.[1]).toMatchObject({ amber_threshold_percent: 1 })
    updateSlaTierMock.mockClear()
    fireEvent.change(input, { target: { value: '100' } })
    fireEvent.blur(input)
    await waitFor(() => expect(updateSlaTierMock).toHaveBeenCalled())
    const secondCall = updateSlaTierMock.mock.calls[0]
    expect(secondCall).toBeDefined()
    expect(secondCall?.[1]).toMatchObject({ amber_threshold_percent: 100 })
  })
})

// Multi-tier follow-on — per-group priority overrides UI in the Priority
// Overrides section. Covers: global row (NULL group_id) behavior preserved,
// per-group rows render + delete with serviceGroupId, "+Add" flow creates a
// new (priority, group) override.
describe('SlaPane — per-group priority overrides', () => {
  const HPLC_TIER = {
    id: 2, name: 'HPLC 24h', target_minutes: 1440, business_hours_only: false,
    is_default: false, amber_threshold_percent: 20,
    created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00',
  }
  const STER_TIER = {
    id: 3, name: 'Sterility 7d', target_minutes: 10080, business_hours_only: false,
    is_default: false, amber_threshold_percent: 20,
    created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00',
  }
  const DEFAULT_TIER = {
    id: 1, name: 'Standard', target_minutes: 1440, business_hours_only: false,
    is_default: true, amber_threshold_percent: 25,
    created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00',
  }
  const HPLC_GROUP = { id: 10, name: 'HPLC', sla_tier_id: HPLC_TIER.id, member_ids: [], member_count: 0, description: null, color: 'blue', sort_order: 0, is_default: false }
  const STER_GROUP = { id: 11, name: 'Sterility', sla_tier_id: STER_TIER.id, member_ids: [], member_count: 0, description: null, color: 'red', sort_order: 1, is_default: false }

  beforeEach(() => {
    getSlaTiersMock.mockResolvedValue([DEFAULT_TIER, HPLC_TIER, STER_TIER])
    getServiceGroupsMock.mockResolvedValue([HPLC_GROUP, STER_GROUP])
  })

  it('renders a per-group row for each existing (priority, group_id != null) override', async () => {
    getSlaPriorityTiersMock.mockResolvedValue([
      // Global expedited → HPLC tier
      { id: 1, priority: 'expedited', sla_tier_id: HPLC_TIER.id, service_group_id: null },
      // Per-group expedited + HPLC group → HPLC tier
      { id: 2, priority: 'expedited', sla_tier_id: HPLC_TIER.id, service_group_id: HPLC_GROUP.id },
    ])
    render(<SlaPane />, { wrapper })
    await screen.findByTestId('sla-priority-block-expedited')
    expect(
      screen.getByTestId(`sla-priority-group-row-expedited-${HPLC_GROUP.id}`)
    ).toBeInTheDocument()
    // No per-group row for sterility (not configured).
    expect(
      screen.queryByTestId(`sla-priority-group-row-expedited-${STER_GROUP.id}`)
    ).toBeNull()
  })

  it('setting tier on the global row calls setSlaPriorityTier with serviceGroupId omitted (null)', async () => {
    render(<SlaPane />, { wrapper })
    await screen.findByTestId('sla-priority-global-tier-high')
    // Use the underlying hidden combobox via aria-label is fragile — instead
    // exercise the mutation by simulating the same code path:
    // Radix Select doesn't fire change without DOM interaction, so we click
    // the trigger then the option. Easier: assert the wiring by clicking the
    // trigger + waiting for popup, then clicking the HPLC option.
    const trigger = screen.getByTestId('sla-priority-global-tier-high')
    fireEvent.click(trigger)
    // Radix renders options in a portal; we wait until they show up.
    const option = await screen.findByRole('option', { name: 'HPLC 24h' })
    fireEvent.click(option)
    await waitFor(() => {
      expect(setSlaPriorityTierMock).toHaveBeenCalled()
    })
    const firstCall = setSlaPriorityTierMock.mock.calls[0]
    expect(firstCall?.[0]).toBe('high')
    expect(firstCall?.[1]).toBe(HPLC_TIER.id)
    // serviceGroupId is null/undefined for the global row.
    expect(firstCall?.[2] ?? null).toBeNull()
  })

  it('clicking trash on a per-group row calls deleteSlaPriorityTier with the right serviceGroupId', async () => {
    getSlaPriorityTiersMock.mockResolvedValue([
      { id: 1, priority: 'expedited', sla_tier_id: HPLC_TIER.id, service_group_id: HPLC_GROUP.id },
    ])
    render(<SlaPane />, { wrapper })
    const row = await screen.findByTestId(
      `sla-priority-group-row-expedited-${HPLC_GROUP.id}`
    )
    const deleteBtn = within(row).getByRole('button', { name: /remove/i })
    fireEvent.click(deleteBtn)
    await waitFor(() => {
      expect(deleteSlaPriorityTierMock).toHaveBeenCalled()
    })
    const firstCall = deleteSlaPriorityTierMock.mock.calls[0]
    expect(firstCall?.[0]).toBe('expedited')
    expect(firstCall?.[1]).toBe(HPLC_GROUP.id)
  })

  it('"+Add group-specific override" reveals a pending row that disappears when canceled', async () => {
    render(<SlaPane />, { wrapper })
    const addBtn = await screen.findByTestId('sla-priority-add-group-expedited')
    fireEvent.click(addBtn)
    const pending = await screen.findByTestId(
      'sla-priority-pending-row-expedited'
    )
    expect(pending).toBeInTheDocument()
    // Cancel button (the X) restores the original "+Add" button.
    const cancelBtn = within(pending).getByRole('button', { name: 'cancel' })
    fireEvent.click(cancelBtn)
    await waitFor(() => {
      expect(
        screen.queryByTestId('sla-priority-pending-row-expedited')
      ).toBeNull()
    })
  })

  it('"+Add" button is hidden when every group already has an override for this priority', async () => {
    // Both HPLC and Sterility have expedited overrides → no groups left to add.
    getSlaPriorityTiersMock.mockResolvedValue([
      { id: 1, priority: 'expedited', sla_tier_id: HPLC_TIER.id, service_group_id: HPLC_GROUP.id },
      { id: 2, priority: 'expedited', sla_tier_id: STER_TIER.id, service_group_id: STER_GROUP.id },
    ])
    render(<SlaPane />, { wrapper })
    await screen.findByTestId('sla-priority-block-expedited')
    expect(
      screen.queryByTestId('sla-priority-add-group-expedited')
    ).toBeNull()
  })
})
