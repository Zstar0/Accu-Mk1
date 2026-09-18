import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelScheduledPublish,
  getScheduledPublishes,
  type ScheduledPublishList,
  type ScheduledPublishRow,
} from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'
import { untilText } from '@/lib/scheduled-publish'
import { ScheduledPublishesReport } from './ScheduledPublishesReport'

vi.mock('@/lib/api', () => ({
  getScheduledPublishes: vi.fn(),
  cancelScheduledPublish: vi.fn(),
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))
const mockList = vi.mocked(getScheduledPublishes)
const mockCancel = vi.mocked(cancelScheduledPublish)

function row(
  over: Partial<ScheduledPublishRow> & { id: number; sample_id: string }
): ScheduledPublishRow {
  return {
    scheduled_at: '2026-09-19T17:00:00Z',
    pdf_date: '09/19/2026',
    status: 'pending',
    created_by_user_id: 2,
    created_at: '2026-09-17T22:00:00Z',
    fired_at: null,
    last_error: null,
    cancelled_at: null,
    client: 'Acme',
    order: '7001',
    received_at: '2026-09-16T17:00:00Z',
    sample_status: 'verified',
    created_by: 'Dana Tech',
    ...over,
  }
}

function list(rows: ScheduledPublishRow[]): ScheduledPublishList {
  const totals = {
    pending: 0,
    firing: 0,
    failed: 0,
    published: 0,
    cancelled: 0,
  }
  for (const r of rows) totals[r.status] += 1
  return {
    generated_at: '2026-09-18T17:00:00Z',
    lab_timezone: 'America/Los_Angeles',
    rows,
    totals,
  }
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ScheduledPublishesReport />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

describe('ScheduledPublishesReport', () => {
  beforeEach(() => {
    mockList.mockReset()
    mockCancel.mockReset()
  })

  it('lists rows, offers the trash only on pending and failed', async () => {
    mockList.mockResolvedValue(
      list([
        row({ id: 3, sample_id: 'P-3', status: 'firing' }),
        row({ id: 1, sample_id: 'P-1' }),
        row({ id: 2, sample_id: 'P-2', status: 'failed', last_error: 'boom' }),
      ])
    )
    mount()
    const rows = await screen.findAllByTestId('sp-row')
    expect(rows.map(r => r.getAttribute('data-sample-id'))).toEqual([
      'P-3',
      'P-1',
      'P-2',
    ])
    expect(screen.getAllByTestId('sp-remove')).toHaveLength(2)
    expect(screen.getByText('1 scheduled')).toBeTruthy()
    expect(screen.getByText('1 failed')).toBeTruthy()
    expect(screen.getByText('in 1d')).toBeTruthy()
  })

  it('trash confirms, cancels by sample id and refetches', async () => {
    mockList.mockResolvedValue(list([row({ id: 1, sample_id: 'P-1' })]))
    mockCancel.mockResolvedValue({
      success: true,
      message: 'Schedule cancelled',
      verification_code: null,
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mount()
    fireEvent.click(await screen.findByTestId('sp-remove'))
    await waitFor(() => expect(mockCancel).toHaveBeenCalledWith('P-1'))
    expect(confirm.mock.calls[0]?.[0]).toContain("today's date")
    await waitFor(() => expect(mockList.mock.calls.length).toBeGreaterThan(1))
    confirm.mockRestore()
  })

  it('does nothing when the confirm is declined', async () => {
    mockList.mockResolvedValue(list([row({ id: 1, sample_id: 'P-1' })]))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    mount()
    fireEvent.click(await screen.findByTestId('sp-remove'))
    expect(mockCancel).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('asks for history when the toggle is on', async () => {
    mockList.mockResolvedValue(list([]))
    mount()
    await screen.findByText(/Nothing is scheduled/)
    fireEvent.click(screen.getByTestId('sp-history-toggle'))
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith({ includeHistory: true })
    )
  })

  it('untilText measures against the server clock', () => {
    expect(untilText('2026-09-19T17:00:00Z', '2026-09-18T17:00:00Z')).toBe(
      'in 1d'
    )
    expect(untilText('2026-09-18T16:00:00Z', '2026-09-18T17:00:00Z')).toBe(
      'due'
    )
  })
})
