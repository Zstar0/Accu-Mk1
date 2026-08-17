import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
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
      loq: null,
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
      loq: null,
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

  // ── LOQ (COA display fields, 2026-08-16 spec, task 5) ──

  it('includes loq in the POST payload for a range spec when LOQ is filled', async () => {
    const { createServiceSpec } = await import('@/lib/api')
    const user = userEvent.setup()
    render(<ServiceSpecsSection serviceId={42} peptides={[]} />)
    await screen.findByText('Specs (2)')

    await user.type(screen.getByLabelText('Max'), '100')
    await user.type(screen.getByLabelText('LOQ'), '0.5')
    await user.click(screen.getByRole('button', { name: /add spec/i }))

    await waitFor(() => {
      expect(createServiceSpec).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ max_value: '100', loq: '0.5' })
      )
    })
  })

  it('sends loq: null for a range spec when LOQ is left blank', async () => {
    const { createServiceSpec } = await import('@/lib/api')
    const user = userEvent.setup()
    render(<ServiceSpecsSection serviceId={42} peptides={[]} />)
    await screen.findByText('Specs (2)')

    await user.type(screen.getByLabelText('Max'), '100')
    await user.click(screen.getByRole('button', { name: /add spec/i }))

    await waitFor(() => {
      expect(createServiceSpec).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ loq: null })
      )
    })
  })

  it('sends loq: null for an equals-kind spec (LOQ input is not shown)', async () => {
    const { createServiceSpec } = await import('@/lib/api')
    const user = userEvent.setup()
    render(<ServiceSpecsSection serviceId={42} peptides={[]} />)
    await screen.findByText('Specs (2)')

    // Radix Select doesn't fire change from userEvent's full pointer-event
    // sequence under jsdom (hasPointerCapture isn't implemented there) —
    // fireEvent.click sidesteps it, same workaround as
    // analysis-profiles-fulfillment.test.tsx:290-294.
    fireEvent.click(screen.getByRole('combobox', { name: 'Rule' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Equals' }))

    expect(screen.queryByLabelText('LOQ')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('Equals'), 'Not Detected')
    await user.click(screen.getByRole('button', { name: /add spec/i }))

    await waitFor(() => {
      expect(createServiceSpec).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ rule_kind: 'equals', loq: null })
      )
    })
  })

  it('shows LOQ in the read-only spec row summary when set', async () => {
    const { listServiceSpecs } = await import('@/lib/api')
    const rangeSpec = specs.find(s => s.id === 1)
    if (!rangeSpec) throw new Error('expected the range spec fixture')
    vi.mocked(listServiceSpecs).mockResolvedValueOnce([
      { ...rangeSpec, id: 3, loq: '0.1' },
    ])
    render(<ServiceSpecsSection serviceId={42} peptides={[]} />)

    expect(await screen.findByText('≤ 0.5 µg/g · LOQ 0.1')).toBeInTheDocument()
  })
})
