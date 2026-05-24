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
