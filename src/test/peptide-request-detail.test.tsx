import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { PeptideRequest } from '@/types/peptide-request'

// Mock the hooks module before importing the page so the page picks up the mock.
vi.mock('@/hooks/peptide-requests', () => ({
  usePeptideRequestsList: vi.fn(),
  usePeptideRequest: vi.fn(),
  usePeptideRequestHistory: vi.fn(),
}))

// Mock the ui-store so the detail page reads a deterministic target id.
vi.mock('@/store/ui-store', () => {
  const state = {
    peptideRequestTargetId: 'req-123',
    setActiveSubSection: vi.fn(),
  }
  const useUIStore = <T,>(selector: (s: typeof state) => T): T =>
    selector(state)
  useUIStore.getState = () => state
  return { useUIStore }
})

const { usePeptideRequest, usePeptideRequestHistory } = await import(
  '@/hooks/peptide-requests'
)
const { PeptideRequestDetail } = await import('@/pages/PeptideRequestDetail')

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function makeRequest(overrides: Partial<PeptideRequest> = {}): PeptideRequest {
  return {
    id: 'req-123',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    source: 'wp',
    submitted_by_wp_user_id: 42,
    submitted_by_email: 'researcher@example.com',
    submitted_by_name: 'Dr. Researcher',
    compound_kind: 'peptide',
    compound_name: 'BPC-157',
    vendor_producer: 'Acme Peptides',
    sequence_or_structure: 'GEPPPGKPADDAGLV',
    molecular_weight: 1419.55,
    cas_or_reference: 'CAS-12345',
    vendor_catalog_number: 'ACME-BPC157',
    reason_notes: 'Client request',
    expected_monthly_volume: 100,
    status: 'new',
    previous_status: null,
    rejection_reason: null,
    sample_id: null,
    clickup_task_id: null,
    clickup_list_id: 'list-1',
    clickup_assignee_ids: [],
    senaite_service_uid: null,
    wp_coupon_code: null,
    wp_coupon_issued_at: null,
    completed_at: null,
    rejected_at: null,
    cancelled_at: null,
    ...overrides,
  }
}

interface DetailHookReturn {
  isLoading: boolean
  isError: boolean
  data: PeptideRequest | undefined
}

function mockDetail(overrides: Partial<DetailHookReturn> = {}): DetailHookReturn {
  return {
    isLoading: false,
    isError: false,
    data: undefined,
    ...overrides,
  }
}

function mockHistory() {
  return {
    isLoading: false,
    isError: false,
    data: [],
  }
}

describe('PeptideRequestDetail', () => {
  beforeEach(() => {
    vi.mocked(usePeptideRequest).mockReset()
    vi.mocked(usePeptideRequestHistory).mockReset()
    vi.mocked(usePeptideRequestHistory).mockReturnValue(
      mockHistory() as unknown as ReturnType<typeof usePeptideRequestHistory>
    )
  })

  it('renders_loading_state', () => {
    vi.mocked(usePeptideRequest).mockReturnValue(
      mockDetail({ isLoading: true }) as unknown as ReturnType<
        typeof usePeptideRequest
      >
    )

    render(<PeptideRequestDetail />, { wrapper })

    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('renders_submission_fields', () => {
    vi.mocked(usePeptideRequest).mockReturnValue(
      mockDetail({ data: makeRequest() }) as unknown as ReturnType<
        typeof usePeptideRequest
      >
    )

    render(<PeptideRequestDetail />, { wrapper })

    expect(screen.getByText('BPC-157')).toBeInTheDocument()
    expect(screen.getByText(/Acme Peptides/)).toBeInTheDocument()
    expect(screen.getByText('GEPPPGKPADDAGLV')).toBeInTheDocument()
    expect(screen.getByText(/Dr\. Researcher/)).toBeInTheDocument()
    expect(screen.getByText('ACME-BPC157')).toBeInTheDocument()
  })

  it('renders_rejection_section_when_rejected', () => {
    vi.mocked(usePeptideRequest).mockReturnValue(
      mockDetail({
        data: makeRequest({
          status: 'rejected',
          rejection_reason: 'No reason',
        }),
      }) as unknown as ReturnType<typeof usePeptideRequest>
    )

    render(<PeptideRequestDetail />, { wrapper })

    expect(screen.getByText(/rejection reason/i)).toBeInTheDocument()
    expect(screen.getByText('No reason')).toBeInTheDocument()
  })

  it('renders_completion_section_with_coupon_when_completed', () => {
    vi.mocked(usePeptideRequest).mockReturnValue(
      mockDetail({
        data: makeRequest({
          status: 'completed',
          wp_coupon_code: 'SAVE250',
        }),
      }) as unknown as ReturnType<typeof usePeptideRequest>
    )

    render(<PeptideRequestDetail />, { wrapper })

    expect(screen.getByText(/completion/i)).toBeInTheDocument()
    expect(screen.getByText('SAVE250')).toBeInTheDocument()
  })
})
