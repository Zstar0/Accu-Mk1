import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ServiceSpecsSection } from '@/components/hplc/ServiceSpecsSection'
import type { AnalysisServiceSpecRecord } from '@/lib/api'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

// vi.mock factories are hoisted above the whole file, so the fixture data
// referenced inside must be declared via vi.hoisted — a plain top-level
// const here would still be in its TDZ when the factory runs.
const { specs } = vi.hoisted(() => {
  const specs: AnalysisServiceSpecRecord[] = [
    {
      id: 1,
      analysis_service_id: 42,
      matrix: null,
      peptide_id: null,
      peptide_code: null,
      rule_kind: 'range',
      min_value: null,
      max_value: '0.5',
      equals_value: null,
      unit: 'µg/g',
      display_override: null,
      active: true,
      updated_at: '2026-08-14T00:00:00Z',
    },
    {
      id: 2,
      analysis_service_id: 42,
      matrix: 'Peptide',
      peptide_id: null,
      peptide_code: null,
      rule_kind: 'equals',
      min_value: null,
      max_value: null,
      equals_value: 'Not Detected',
      unit: null,
      display_override: 'ND',
      active: true,
      updated_at: '2026-08-14T00:00:00Z',
    },
  ]
  return { specs }
})

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    listServiceSpecs: vi.fn().mockResolvedValue(specs),
    createServiceSpec: vi.fn(),
    patchServiceSpec: vi.fn(),
  }
})

describe('ServiceSpecsSection', () => {
  it('loads and renders active spec rows with readable rule text', async () => {
    render(<ServiceSpecsSection serviceId={42} peptides={[]} />)

    expect(await screen.findByText('Specs (2)')).toBeInTheDocument()

    const rows = screen.getAllByRole('row')
    // rows[0] is the header row; data rows follow in the order the mock
    // fetcher returned them.
    const [, rangeRow, equalsRow] = rows
    if (!rangeRow || !equalsRow) throw new Error('expected 2 data rows')

    // Range rule with max only -> "≤ 0.5 µg/g"; tier chip "All" (no matrix/peptide).
    expect(within(rangeRow).getByText('≤ 0.5 µg/g')).toBeInTheDocument()
    expect(within(rangeRow).getByText('All')).toBeInTheDocument()

    // Equals rule -> "= Not Detected"; tier chip "Peptide" (matrix set); display override "ND".
    expect(within(equalsRow).getByText('= Not Detected')).toBeInTheDocument()
    expect(within(equalsRow).getByText('Peptide')).toBeInTheDocument()
    expect(within(equalsRow).getByText('ND')).toBeInTheDocument()
  })

  it('disables Add Spec until the default range shape has a min or max', async () => {
    const user = userEvent.setup()
    render(<ServiceSpecsSection serviceId={42} peptides={[]} />)
    await screen.findByText('Specs (2)')

    const addButton = screen.getByRole('button', { name: /add spec/i })
    expect(addButton).toBeDisabled()

    await user.type(screen.getByLabelText('Min'), '1')
    await waitFor(() => expect(addButton).not.toBeDisabled())
  })
})
