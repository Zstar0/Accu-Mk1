import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { SenaiteLookupResult } from '@/lib/api'

// Selector-callable ui-store mock (canonical pattern from
// src/test/peptide-request-detail.test.tsx:15-25).
const navigateToSampleMock = vi.fn()
vi.mock('@/store/ui-store', () => {
  const state = {
    navigateToSample: navigateToSampleMock,
  }
  const useUIStore = <T,>(selector: (s: typeof state) => T): T =>
    selector(state)
  useUIStore.getState = () => state
  return { useUIStore }
})

// Mock api-profiles per PATTERNS §test-bootstrap-Risk-9 (no env churn).
vi.mock('@/lib/api-profiles', () => ({
  getActiveEnvironmentName: vi.fn().mockReturnValue('test-env'),
  API_PROFILE_CHANGED_EVENT: 'api-profile-changed',
}))

// Stub the api module so type-only imports resolve.
vi.mock('@/lib/api', () => ({
  lookupSenaiteSample: vi.fn(),
}))

const { SampleCard } = await import('@/components/explorer/SampleCard')

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function makeLookup(
  overrides: Partial<SenaiteLookupResult> = {}
): SenaiteLookupResult {
  return {
    sample_id: 'SAMP-001',
    sample_uid: null,
    client: null,
    contact: null,
    sample_type: null,
    date_received: null,
    date_sampled: null,
    profiles: [],
    client_order_number: null,
    client_sample_id: null,
    client_lot: null,
    review_state: null,
    declared_weight_mg: null,
    analytes: [],
    coa: {
      has_coa: false,
      file_count: 0,
      has_download_warnings: false,
    } as never,
    remarks: [],
    analyses: [],
    attachments: [],
    published_coa: null,
    senaite_url: null,
    cached_at: null,
    ...overrides,
  }
}

describe('SampleCard', () => {
  it('renders_loading_spinner_and_sample_id_when_isLoading', () => {
    render(
      <SampleCard
        sampleId="SAMP-001"
        lookup={undefined}
        isLoading={true}
        isError={false}
      />,
      { wrapper }
    )
    expect(screen.getByText('SAMP-001')).toBeInTheDocument()
    // Spinner is the only element with animate-spin in the rendered tree
    const spinner = document.querySelector('.animate-spin')
    expect(spinner).not.toBeNull()
  })

  it('renders_failed_to_load_when_isError_with_no_lookup', () => {
    render(
      <SampleCard
        sampleId="SAMP-002"
        lookup={undefined}
        isLoading={false}
        isError={true}
      />,
      { wrapper }
    )
    expect(screen.getByText('SAMP-002')).toBeInTheDocument()
    expect(screen.getByText('Failed to load')).toBeInTheDocument()
  })

  it('renders_alert_triangle_and_to_verify_badge_when_to_be_verified', () => {
    const lookup = makeLookup({
      review_state: 'to_be_verified',
      analyses: [{ review_state: 'to_be_verified' } as never],
    })
    const { container } = render(
      <SampleCard
        sampleId="SAMP-003"
        lookup={lookup}
        isLoading={false}
        isError={false}
      />,
      { wrapper }
    )
    // Badge with "To Verify" label
    expect(screen.getByText('To Verify')).toBeInTheDocument()
    // AlertTriangle icon — lucide-react v0.561+ renders with class
    // 'lucide-triangle-alert' (renamed from earlier 'lucide-alert-triangle').
    const alertIcon = container.querySelector(
      '.lucide-triangle-alert, .lucide-alert-triangle'
    )
    expect(alertIcon).not.toBeNull()
  })

  it('calls_navigateToSample_when_sample_id_button_clicked', () => {
    navigateToSampleMock.mockClear()
    const lookup = makeLookup({
      sample_id: 'SAMP-004',
      review_state: 'verified',
    })
    render(
      <SampleCard
        sampleId="SAMP-004"
        lookup={lookup}
        isLoading={false}
        isError={false}
      />,
      { wrapper }
    )
    // Click the sample-id button
    fireEvent.click(screen.getByRole('button', { name: 'SAMP-004' }))
    expect(navigateToSampleMock).toHaveBeenCalledWith('SAMP-004')
  })
})

// Phase 31 — at-a-glance analyte display on the SampleCard.
// Source of truth is the order payload (`payload.samples[i].sample_identity`),
// not SENAITE, so it must render on all three branches (loading / error /
// normal). When the prop is absent or empty, the analyte sub-row is omitted so
// callers don't get a stray whitespace gap.
describe('SampleCard — analyte display (Phase 31)', () => {
  it('renders analyte text on the normal branch when provided', () => {
    const lookup = makeLookup({ review_state: 'verified' })
    render(
      <SampleCard
        sampleId="P-0001"
        lookup={lookup}
        isLoading={false}
        isError={false}
        analyte="BPC-157"
      />,
      { wrapper }
    )
    expect(screen.getByText('BPC-157')).toBeInTheDocument()
    expect(screen.getByTestId('sample-card-analyte-P-0001')).toBeInTheDocument()
  })

  it('omits the analyte sub-row entirely when analyte is undefined', () => {
    const lookup = makeLookup({ review_state: 'verified' })
    render(
      <SampleCard
        sampleId="P-0001"
        lookup={lookup}
        isLoading={false}
        isError={false}
      />,
      { wrapper }
    )
    expect(
      screen.queryByTestId('sample-card-analyte-P-0001')
    ).not.toBeInTheDocument()
  })

  it('omits the analyte sub-row when analyte is empty string', () => {
    const lookup = makeLookup({ review_state: 'verified' })
    render(
      <SampleCard
        sampleId="P-0001"
        lookup={lookup}
        isLoading={false}
        isError={false}
        analyte=""
      />,
      { wrapper }
    )
    expect(
      screen.queryByTestId('sample-card-analyte-P-0001')
    ).not.toBeInTheDocument()
  })

  it('sets the title attribute to the full text for comma-delimited multi-analyte values', () => {
    const lookup = makeLookup({ review_state: 'verified' })
    render(
      <SampleCard
        sampleId="P-0001"
        lookup={lookup}
        isLoading={false}
        isError={false}
        analyte="KPV, GHK-Cu, BPC-157, TB-500"
      />,
      { wrapper }
    )
    const el = screen.getByTestId('sample-card-analyte-P-0001')
    expect(el).toHaveAttribute('title', 'KPV, GHK-Cu, BPC-157, TB-500')
    expect(el).toHaveTextContent('KPV, GHK-Cu, BPC-157, TB-500')
    // Tailwind `truncate` ellipsis class is on the analyte row.
    expect(el.className).toMatch(/truncate/)
  })

  it('renders analyte on the loading branch (payload-sourced, not SENAITE)', () => {
    render(
      <SampleCard
        sampleId="P-0001"
        lookup={undefined}
        isLoading={true}
        isError={false}
        analyte="Retatrutide"
      />,
      { wrapper }
    )
    expect(screen.getByText('Retatrutide')).toBeInTheDocument()
    expect(screen.getByTestId('sample-card-analyte-P-0001')).toBeInTheDocument()
  })

  it('renders analyte on the error branch (payload-sourced, not SENAITE)', () => {
    render(
      <SampleCard
        sampleId="P-0001"
        lookup={undefined}
        isLoading={false}
        isError={true}
        analyte="Tirzepatide"
      />,
      { wrapper }
    )
    expect(screen.getByText('Tirzepatide')).toBeInTheDocument()
    expect(screen.getByTestId('sample-card-analyte-P-0001')).toBeInTheDocument()
  })
})

// D2 follow-on — per-sample SLA indicator on the table-view sample card.
// Replaces the legacy hardcoded 24h/48h goalNote with the real tier-resolved
// indicator (same primitive as KanbanSampleCard). Gate matches the legacy
// timer's gate: lookup.date_received present AND review_state !== 'published'.
describe('SampleCard — slaSnapshot indicator', () => {
  const baseSnapshot = {
    color: 'amber' as const,
    status: {
      target_minutes: 100,
      elapsed_minutes: 80,
      remaining_minutes: 20,
      breached: false,
    },
    tier: {
      id: 1,
      name: 'Standard',
      target_minutes: 100,
      business_hours_only: false,
      is_default: true,
      amber_threshold_percent: 30,
      created_at: '2026-01-01T00:00:00',
      updated_at: '2026-01-01T00:00:00',
    },
    reason: { tierSource: 'default' as const, unmappedKeywords: [] },
    priority: 'normal' as const,
  }

  it('renders SampleSlaIndicator when slaSnapshot is provided on a non-published sample', () => {
    const lookup = makeLookup({
      review_state: 'verified',
      date_received: '2026-05-01T00:00:00Z',
    })
    render(
      <SampleCard
        sampleId="SAMP-SLA-1"
        lookup={lookup}
        isLoading={false}
        isError={false}
        slaSnapshot={baseSnapshot}
      />,
      { wrapper }
    )
    const indicator = screen.getByTestId('sample-sla-indicator')
    expect(indicator).toBeInTheDocument()
    expect(indicator.getAttribute('data-sla-color')).toBe('amber')
  })

  it('omits the SLA indicator when slaSnapshot is provided but sample is published (gate preserved)', () => {
    const lookup = makeLookup({
      review_state: 'published',
      date_received: '2026-05-01T00:00:00Z',
    })
    render(
      <SampleCard
        sampleId="SAMP-SLA-2"
        lookup={lookup}
        isLoading={false}
        isError={false}
        slaSnapshot={baseSnapshot}
      />,
      { wrapper }
    )
    expect(screen.queryByTestId('sample-sla-indicator')).toBeNull()
  })

  it('omits the SLA indicator when lookup has no date_received (gate preserved)', () => {
    const lookup = makeLookup({
      review_state: 'verified',
      date_received: null,
    })
    render(
      <SampleCard
        sampleId="SAMP-SLA-3"
        lookup={lookup}
        isLoading={false}
        isError={false}
        slaSnapshot={baseSnapshot}
      />,
      { wrapper }
    )
    expect(screen.queryByTestId('sample-sla-indicator')).toBeNull()
  })

  it('renders no indicator (and no legacy 24/48h timer) when slaSnapshot is omitted', () => {
    const lookup = makeLookup({
      review_state: 'verified',
      date_received: '2026-05-01T00:00:00Z',
    })
    render(
      <SampleCard
        sampleId="SAMP-SLA-4"
        lookup={lookup}
        isLoading={false}
        isError={false}
      />,
      { wrapper }
    )
    expect(screen.queryByTestId('sample-sla-indicator')).toBeNull()
  })
})
