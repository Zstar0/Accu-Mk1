import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { PeptideRequest } from '@/types/peptide-request'

// Mock the hooks module before importing the page so the page picks up the mock.
vi.mock('@/hooks/peptide-requests', () => ({
  usePeptideRequestsList: vi.fn(),
  usePeptideRequest: vi.fn(),
  usePeptideRequestHistory: vi.fn(),
  useUpdatePeptideRequest: vi.fn(),
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

const { usePeptideRequest, usePeptideRequestHistory, useUpdatePeptideRequest } =
  await import('@/hooks/peptide-requests')
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
    retired_at: null,
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

function mockUpdate(overrides: {
  mutate?: ReturnType<typeof vi.fn>
  isPending?: boolean
  isError?: boolean
} = {}) {
  return {
    mutate: overrides.mutate ?? vi.fn(),
    isPending: overrides.isPending ?? false,
    isError: overrides.isError ?? false,
  }
}

describe('PeptideRequestDetail', () => {
  beforeEach(() => {
    vi.mocked(usePeptideRequest).mockReset()
    vi.mocked(usePeptideRequestHistory).mockReset()
    vi.mocked(useUpdatePeptideRequest).mockReset()
    vi.mocked(usePeptideRequestHistory).mockReturnValue(
      mockHistory() as unknown as ReturnType<typeof usePeptideRequestHistory>
    )
    vi.mocked(useUpdatePeptideRequest).mockReturnValue(
      mockUpdate() as unknown as ReturnType<typeof useUpdatePeptideRequest>
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

  it('renders_clickable_sample_id_affordance_when_empty', () => {
    vi.mocked(usePeptideRequest).mockReturnValue(
      mockDetail({ data: makeRequest({ sample_id: null }) }) as unknown as ReturnType<
        typeof usePeptideRequest
      >
    )

    render(<PeptideRequestDetail />, { wrapper })

    expect(screen.getByText('Sample ID')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /edit sample id/i })
    ).toBeInTheDocument()
    expect(screen.getByText(/click to add/i)).toBeInTheDocument()
  })

  it('renders_existing_sample_id_value', () => {
    vi.mocked(usePeptideRequest).mockReturnValue(
      mockDetail({
        data: makeRequest({ sample_id: 'SMP-777' }),
      }) as unknown as ReturnType<typeof usePeptideRequest>
    )

    render(<PeptideRequestDetail />, { wrapper })

    expect(screen.getByText('SMP-777')).toBeInTheDocument()
  })

  it('calls_mutation_when_sample_id_saved', () => {
    const mutate = vi.fn()
    vi.mocked(useUpdatePeptideRequest).mockReturnValue(
      mockUpdate({ mutate }) as unknown as ReturnType<
        typeof useUpdatePeptideRequest
      >
    )
    vi.mocked(usePeptideRequest).mockReturnValue(
      mockDetail({ data: makeRequest({ sample_id: null }) }) as unknown as ReturnType<
        typeof usePeptideRequest
      >
    )

    render(<PeptideRequestDetail />, { wrapper })

    fireEvent.click(screen.getByRole('button', { name: /edit sample id/i }))
    const input = screen.getByRole('textbox', { name: /sample id/i })
    fireEvent.change(input, { target: { value: 'SMP-101' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    expect(mutate).toHaveBeenCalledWith(
      { sample_id: 'SMP-101' },
      expect.any(Object)
    )
  })

  it('mutation_payload_is_null_when_cleared', () => {
    const mutate = vi.fn()
    vi.mocked(useUpdatePeptideRequest).mockReturnValue(
      mockUpdate({ mutate }) as unknown as ReturnType<
        typeof useUpdatePeptideRequest
      >
    )
    vi.mocked(usePeptideRequest).mockReturnValue(
      mockDetail({
        data: makeRequest({ sample_id: 'SMP-old' }),
      }) as unknown as ReturnType<typeof usePeptideRequest>
    )

    render(<PeptideRequestDetail />, { wrapper })

    fireEvent.click(screen.getByRole('button', { name: /edit sample id/i }))
    const input = screen.getByRole('textbox', { name: /sample id/i })
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mutate).toHaveBeenCalledWith(
      { sample_id: null },
      expect.any(Object)
    )
  })
})
