import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

// Mock the hooks module before importing the component.
vi.mock('@/hooks/peptide-requests', async () => {
  const actual = await vi.importActual<
    typeof import('@/hooks/peptide-requests')
  >('@/hooks/peptide-requests')
  return {
    ...actual,
    useSyncDiff: vi.fn(),
    useApplySync: vi.fn(),
  }
})

const { useSyncDiff, useApplySync } = await import('@/hooks/peptide-requests')
const { SyncClickUpModal } = await import('@/components/sync-clickup-modal')

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const diffFixture = {
  in_clickup_not_mk1: [
    {
      task_id: 't1',
      name: 'NewTaskOne',
      clickup_status: 'requested',
      clickup_url: 'https://app.clickup.com/t/t1',
      creator_username: 'alice',
    },
    {
      task_id: 't2',
      name: 'NewTaskTwo',
      clickup_status: 'requested',
      clickup_url: 'https://app.clickup.com/t/t2',
      creator_username: 'bob',
    },
  ],
  in_mk1_not_clickup: [
    {
      row_id: 'row-a',
      clickup_task_id: 't_gone_a',
      compound_name: 'OrphanA',
      status: 'new' as const,
      created_at: '2025-01-01T00:00:00Z',
    },
  ],
  status_mismatch: [
    {
      row_id: 'row-z',
      clickup_task_id: 't_drift_z',
      compound_name: 'DriftedZ',
      mk1_status: 'new' as const,
      clickup_column: 'analyzing',
      mapped_status: 'in_process' as const,
    },
  ],
  field_drift: [
    {
      row_id: 'row-fd-1',
      task_id: 't_fd_1',
      compound_name: 'DriftingCompound',
      field: 'sample_id' as const,
      db_value: 'S-DB-111',
      clickup_value: 'S-CU-222',
    },
    {
      row_id: 'row-fd-2',
      task_id: 't_fd_2',
      compound_name: 'KindDrift',
      field: 'compound_kind' as const,
      db_value: 'peptide',
      clickup_value: 'other',
    },
  ],
}

function mockHooks(opts: {
  data?: typeof diffFixture | undefined
  isLoading?: boolean
  isError?: boolean
  mutateAsync?: ReturnType<typeof vi.fn>
  isPending?: boolean
}) {
  vi.mocked(useSyncDiff).mockReturnValue({
    data: opts.data,
    isLoading: opts.isLoading ?? false,
    isError: opts.isError ?? false,
    error: null,
  } as unknown as ReturnType<typeof useSyncDiff>)

  vi.mocked(useApplySync).mockReturnValue({
    mutateAsync: opts.mutateAsync ?? vi.fn().mockResolvedValue({
      materialized: 0,
      retired: 0,
      fixed_status: 0,
      errors: [],
    }),
    isPending: opts.isPending ?? false,
  } as unknown as ReturnType<typeof useApplySync>)
}

describe('SyncClickUpModal', () => {
  beforeEach(() => {
    vi.mocked(useSyncDiff).mockReset()
    vi.mocked(useApplySync).mockReset()
  })

  it('renders all 3 sections when open with seeded data', () => {
    mockHooks({ data: diffFixture })
    render(
      <SyncClickUpModal open={true} onOpenChange={() => {}} />,
      { wrapper },
    )

    expect(screen.getByText('Create in Accu-Mk1')).toBeInTheDocument()
    expect(screen.getByText('Retire in Accu-Mk1')).toBeInTheDocument()
    expect(screen.getByText('Fix status')).toBeInTheDocument()

    // Items from each bucket render by their primary label.
    expect(screen.getByText('NewTaskOne')).toBeInTheDocument()
    expect(screen.getByText('NewTaskTwo')).toBeInTheDocument()
    expect(screen.getByText('OrphanA')).toBeInTheDocument()
    expect(screen.getByText('DriftedZ')).toBeInTheDocument()
  })

  it('Apply button is disabled when nothing is selected', () => {
    mockHooks({ data: diffFixture })
    render(
      <SyncClickUpModal open={true} onOpenChange={() => {}} />,
      { wrapper },
    )

    const applyBtn = screen.getByTestId('sync-apply-btn')
    expect(applyBtn).toBeDisabled()
    expect(applyBtn).toHaveTextContent(/apply \(0 actions\)/i)
  })

  it('Apply count reflects selections across all three sections', async () => {
    const user = userEvent.setup()
    mockHooks({ data: diffFixture })
    render(
      <SyncClickUpModal open={true} onOpenChange={() => {}} />,
      { wrapper },
    )

    // Click the row checkbox for NewTaskOne (materialize bucket).
    const createRow = screen.getByText('NewTaskOne').closest('label')!
    await user.click(within(createRow).getByRole('checkbox'))

    const applyBtn = screen.getByTestId('sync-apply-btn')
    expect(applyBtn).toHaveTextContent(/apply \(1 action\)/i)
    expect(applyBtn).toBeEnabled()

    // Select both remaining sections by clicking their rows.
    const retireRow = screen.getByText('OrphanA').closest('label')!
    await user.click(within(retireRow).getByRole('checkbox'))
    const fixRow = screen.getByText('DriftedZ').closest('label')!
    await user.click(within(fixRow).getByRole('checkbox'))

    expect(screen.getByTestId('sync-apply-btn')).toHaveTextContent(
      /apply \(3 actions\)/i,
    )
  })

  it('"Select all" in the Create section picks every task_id', async () => {
    const user = userEvent.setup()
    mockHooks({ data: diffFixture })
    render(
      <SyncClickUpModal open={true} onOpenChange={() => {}} />,
      { wrapper },
    )

    // Find the "Select all" in the Create section by scoping to its heading.
    const header = screen.getByText('Create in Accu-Mk1').closest('header')!
    const selectAll = within(header).getByRole('checkbox')
    await user.click(selectAll)

    // Both items in that bucket are selected -> apply count = 2.
    expect(screen.getByTestId('sync-apply-btn')).toHaveTextContent(
      /apply \(2 actions\)/i,
    )
  })

  it('Apply submits the correct payload built from selections', async () => {
    const user = userEvent.setup()
    const mutateAsync = vi.fn().mockResolvedValue({
      materialized: 1,
      retired: 1,
      fixed_status: 1,
      errors: [],
    })
    mockHooks({ data: diffFixture, mutateAsync })
    render(
      <SyncClickUpModal open={true} onOpenChange={() => {}} />,
      { wrapper },
    )

    // Pick one from each section.
    await user.click(
      within(screen.getByText('NewTaskTwo').closest('label')!).getByRole(
        'checkbox',
      ),
    )
    await user.click(
      within(screen.getByText('OrphanA').closest('label')!).getByRole(
        'checkbox',
      ),
    )
    await user.click(
      within(screen.getByText('DriftedZ').closest('label')!).getByRole(
        'checkbox',
      ),
    )

    await user.click(screen.getByTestId('sync-apply-btn'))

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    const payload = mutateAsync.mock.calls[0]![0]
    expect(payload.materialize_task_ids).toEqual(['t2'])
    expect(payload.retire_row_ids).toEqual(['row-a'])
    expect(payload.fix_status_pairs).toEqual([
      { row_id: 'row-z', target_status: 'in_process' },
    ])

    // Result banner surfaces the counts.
    await waitFor(() => {
      expect(screen.getByTestId('sync-result')).toHaveTextContent(
        /1 created, 1 retired, 1 status fix/,
      )
    })
  })

  // ------------------------------------------------------------------
  // Field drift section
  // ------------------------------------------------------------------

  it('renders a field_drift row per drift item with DB + ClickUp buttons', () => {
    mockHooks({ data: diffFixture })
    render(
      <SyncClickUpModal open={true} onOpenChange={() => {}} />,
      { wrapper },
    )

    // Section heading present.
    expect(screen.getByText('Field drift')).toBeInTheDocument()

    // Both drift items render with their compound + field names.
    expect(screen.getByText(/DriftingCompound/)).toBeInTheDocument()
    expect(screen.getByText(/KindDrift/)).toBeInTheDocument()

    // Both sides' values are rendered on the picker buttons.
    expect(
      screen.getAllByText((_, node) => {
        const text = node?.textContent ?? ''
        return /DB:\s*S-DB-111/.test(text)
      }).length,
    ).toBeGreaterThan(0)
    expect(
      screen.getAllByText((_, node) => {
        const text = node?.textContent ?? ''
        return /ClickUp:\s*S-CU-222/.test(text)
      }).length,
    ).toBeGreaterThan(0)
  })

  it('picking a side adds that drift item to the Apply payload', async () => {
    const user = userEvent.setup()
    const mutateAsync = vi.fn().mockResolvedValue({
      materialized: 0,
      retired: 0,
      fixed_status: 0,
      field_drift_resolved: 1,
      errors: [],
    })
    mockHooks({ data: diffFixture, mutateAsync })
    render(
      <SyncClickUpModal open={true} onOpenChange={() => {}} />,
      { wrapper },
    )

    // Pick ClickUp side for the sample_id drift row. We scope to the
    // row containing the compound name so we don't grab a button from
    // another row.
    const firstDriftRow = screen.getByText(/DriftingCompound/).closest('div')!
      .parentElement!
    const cuBtn = within(firstDriftRow).getByTestId('sync-drift-clickup')
    await user.click(cuBtn)

    // Apply count reflects one drift pick.
    expect(screen.getByTestId('sync-apply-btn')).toHaveTextContent(
      /apply \(1 action\)/i,
    )

    await user.click(screen.getByTestId('sync-apply-btn'))

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    const payload = mutateAsync.mock.calls[0]![0]
    expect(payload.resolve_field_drift).toEqual([
      {
        row_id: 'row-fd-1',
        field: 'sample_id',
        value_to_use: 'clickup',
      },
    ])
    // Other buckets empty.
    expect(payload.materialize_task_ids).toEqual([])
    expect(payload.retire_row_ids).toEqual([])
    expect(payload.fix_status_pairs).toEqual([])

    // Result banner includes the new counter.
    await waitFor(() => {
      expect(screen.getByTestId('sync-result')).toHaveTextContent(
        /1 field drift resolved/,
      )
    })
  })

  it('unchosen drift rows are excluded from the payload', async () => {
    const user = userEvent.setup()
    const mutateAsync = vi.fn().mockResolvedValue({
      materialized: 0,
      retired: 0,
      fixed_status: 0,
      field_drift_resolved: 1,
      errors: [],
    })
    mockHooks({ data: diffFixture, mutateAsync })
    render(
      <SyncClickUpModal open={true} onOpenChange={() => {}} />,
      { wrapper },
    )

    // Pick DB for the first drift row; leave the second one unchosen.
    const firstDriftRow = screen.getByText(/DriftingCompound/).closest('div')!
      .parentElement!
    await user.click(within(firstDriftRow).getByTestId('sync-drift-db'))

    await user.click(screen.getByTestId('sync-apply-btn'))

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    const payload = mutateAsync.mock.calls[0]![0]
    // Exactly one resolution — the unchosen row is excluded.
    expect(payload.resolve_field_drift).toHaveLength(1)
    expect(payload.resolve_field_drift[0]).toMatchObject({
      row_id: 'row-fd-1',
      field: 'sample_id',
      value_to_use: 'db',
    })
  })
})
