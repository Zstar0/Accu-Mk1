import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { SamplePrep } from '@/lib/api'

// Page wiring only: default SLA order, header toggle, creator name. The sort
// rules themselves are covered in src/test/sample-prep-sort.test.ts.

const listMock = vi.fn()
vi.mock('@/lib/api', () => ({
  listSamplePreps: (...a: unknown[]) => listMock(...a),
  updateSamplePrep: vi.fn(),
  deleteSamplePrep: vi.fn(),
}))
vi.mock('../SamplePrepHplcFlyout', () => ({ SamplePrepHplcFlyout: () => null }))
vi.mock('../SharePointBrowser', () => ({ SharePointBrowser: () => null }))
vi.mock('../LocalHplcFolderPicker', () => ({
  LocalHplcFolderPicker: () => null,
}))
vi.mock('@/components/hplc/SlaAgeIndicator', () => ({
  SlaAgeIndicator: () => null,
}))
vi.mock('@/services/service-groups', () => ({
  useServiceGroups: () => ({ data: [] }),
}))
vi.mock('@/components/flags/flag-users', () => ({
  useFlagUsers: () =>
    new Map([
      [
        7,
        {
          id: 7,
          email: 'forrest@accumark.com',
          first_name: 'Forrest',
          last_name: 'Parker',
        },
      ],
    ]),
}))

// remaining minutes per prep id: 1 has time, 2 is overdue, 3 is nearly due, 4 has no clock
const REMAINING: Record<string, number> = { '1': 900, '2': -1152, '3': 288 }
vi.mock('@/services/sla-subjects', () => ({
  useSlaForSubjects: () => ({
    byKey: new Map(
      Object.entries(REMAINING).map(([k, remaining_minutes]) => [
        k,
        { status: { remaining_minutes } },
      ])
    ),
    isLoading: false,
    isError: false,
  }),
}))

const { SamplePreps } = await import('../SamplePreps')

function prep(id: number, over: Partial<SamplePrep> = {}): SamplePrep {
  return {
    id,
    sample_id: `SP-${id}`,
    senaite_sample_id: `P-${1000 + id}`,
    peptide_abbreviation: 'BPC-157',
    is_standard: false,
    status: 'awaiting_hplc',
    declared_weight_mg: null,
    target_conc_ug_ml: null,
    actual_conc_ug_ml: null,
    created_by_user_id: null,
    created_by_email: null,
    created_at: `2026-09-0${id}T00:00:00Z`,
    updated_at: `2026-09-0${id}T00:00:00Z`,
    ...over,
  } as SamplePrep
}

const sampleIds = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map(r => within(r).getAllByRole('cell')[0]?.textContent)

beforeEach(() => {
  listMock
    .mockReset()
    .mockResolvedValue([
      prep(1),
      prep(2, {
        created_by_user_id: 7,
        created_by_email: 'forrest@accumark.com',
      }),
      prep(3, { created_by_email: 'lab.tech@accumark.com' }),
      prep(4),
    ])
})

describe('SamplePreps: sortable columns', () => {
  it('opens sorted by SLA: most overdue first, no-clock rows last', async () => {
    render(<SamplePreps />)
    await screen.findByText('P-1002')
    expect(sampleIds()).toEqual(['P-1002', 'P-1003', 'P-1001', 'P-1004'])
    expect(
      screen
        .getByTestId('prep-sort-sla')
        .closest('th')
        ?.getAttribute('aria-sort')
    ).toBe('ascending')
  })

  it('clicking a header sorts by it, clicking again reverses', async () => {
    render(<SamplePreps />)
    await screen.findByText('P-1002')
    const header = screen.getByTestId('prep-sort-sampleId')
    fireEvent.click(header)
    expect(sampleIds()).toEqual(['P-1001', 'P-1002', 'P-1003', 'P-1004'])
    fireEvent.click(header)
    expect(sampleIds()).toEqual(['P-1004', 'P-1003', 'P-1002', 'P-1001'])
    expect(header.closest('th')?.getAttribute('aria-sort')).toBe('descending')
  })

  it('shows the creator as "F. Lastname", email local part when unknown, email on hover', async () => {
    render(<SamplePreps />)
    const cell = await screen.findByText('F. Parker')
    expect(cell.getAttribute('title')).toBe('forrest@accumark.com')
    expect(screen.getByText('lab.tech')).toBeInTheDocument()
    expect(screen.queryByText('forrest@accumark.com')).toBeNull()
  })
})
