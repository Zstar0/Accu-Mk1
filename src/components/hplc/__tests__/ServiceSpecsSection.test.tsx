import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ServiceSpecsSection,
  ruleLabel,
  tierChip,
} from '@/components/hplc/ServiceSpecsSection'
import type { AnalysisServiceSpecRecord } from '@/lib/api'
import type { SampleForm } from '@/lib/api-sample-forms'

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
      sample_form_id: null,
      sample_form_name: null,
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
      sample_form_id: null,
      sample_form_name: null,
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

const form = (
  id: number,
  name: string,
  over: Partial<SampleForm> = {}
): SampleForm => ({
  id,
  name,
  route: 'injectable',
  is_default: false,
  active: true,
  sort_order: id,
  sample_count: 0,
  ...over,
})

vi.mock('@/lib/api-sample-forms', () => ({
  listSampleForms: vi.fn(),
}))

beforeEach(async () => {
  const { listSampleForms } = await import('@/lib/api-sample-forms')
  vi.mocked(listSampleForms).mockResolvedValue([
    form(1, 'Vial', { is_default: true }),
    form(7, 'Nasal Spray', { route: 'nasal_inhaled' }),
    form(9, 'Old Form', { active: false }),
  ])
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

  it('sends loq: null for an equals-kind spec, even carrying a stale LOQ value typed before switching Rule', async () => {
    const { createServiceSpec } = await import('@/lib/api')
    const user = userEvent.setup()
    render(<ServiceSpecsSection serviceId={42} peptides={[]} />)
    await screen.findByText('Specs (2)')

    // Fill LOQ while still on the range shape so form.loq carries a
    // non-empty value into the Rule switch below — otherwise this test
    // can't distinguish the ruleKind gate from an always-empty string.
    await user.type(screen.getByLabelText('Max'), '100')
    await user.type(screen.getByLabelText('LOQ'), '0.5')

    // Radix Select doesn't fire change from userEvent's full pointer-event
    // sequence under jsdom (hasPointerCapture isn't implemented there) —
    // fireEvent.click sidesteps it, same workaround as
    // analysis-profiles-fulfillment.test.tsx:290-294.
    fireEvent.click(screen.getByRole('combobox', { name: 'Rule' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Equals' }))

    // Unmounting the LOQ input does not clear form.loq (state lives in the
    // parent useState) — the payload gate, not a cleared field, is what
    // must null it out below.
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

  it('informational rule sends all-null bounds and enables Add Spec with no fields filled', async () => {
    const { createServiceSpec } = await import('@/lib/api')
    vi.mocked(createServiceSpec).mockClear()
    const user = userEvent.setup()
    render(<ServiceSpecsSection serviceId={42} peptides={[]} />)
    await screen.findByText('Specs (2)')

    // Type bounds first so the payload gate (not empty strings) is what
    // nulls them after the Rule switch, same discipline as the equals test.
    await user.type(screen.getByLabelText('Max'), '100')

    fireEvent.click(screen.getByRole('combobox', { name: 'Rule' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Report as measured' }))

    // Bounds inputs unmount; LOQ stays (report-only rows may carry one).
    expect(screen.queryByLabelText('Max')).not.toBeInTheDocument()
    expect(screen.getByLabelText('LOQ')).toBeInTheDocument()
    // The helper copy states the censoring: it never claims "prints as-is".
    const helper = screen.getByText(/No verdict\./)
    expect(helper.textContent).toBe(
      'No verdict. The measured value prints with a neutral status; at or below the LOQ it prints as below the LOQ.'
    )

    await user.click(screen.getByRole('button', { name: /add spec/i }))

    await waitFor(() => {
      expect(createServiceSpec).toHaveBeenCalledWith(
        42,
        expect.objectContaining({
          rule_kind: 'informational',
          min_value: null,
          max_value: null,
          equals_value: null,
          loq: null,
        })
      )
    })
  })

  it('report-only shows LOQ input and posts loq', async () => {
    const { createServiceSpec } = await import('@/lib/api')
    vi.mocked(createServiceSpec).mockClear()
    const user = userEvent.setup()
    render(<ServiceSpecsSection serviceId={42} peptides={[]} />)
    await screen.findByText('Specs (2)')

    fireEvent.click(screen.getByRole('combobox', { name: 'Rule' }))
    fireEvent.click(
      await screen.findByRole('option', { name: 'Report as measured' })
    )

    await user.type(screen.getByLabelText('LOQ'), '3.2')
    await user.click(screen.getByRole('button', { name: /add spec/i }))

    await waitFor(() => {
      expect(createServiceSpec).toHaveBeenCalledWith(
        42,
        expect.objectContaining({
          rule_kind: 'informational',
          min_value: null,
          max_value: null,
          equals_value: null,
          loq: '3.2',
        })
      )
    })
  })

  it('form tier posts sample_form_id and no matrix', async () => {
    const { createServiceSpec } = await import('@/lib/api')
    vi.mocked(createServiceSpec).mockClear()
    const user = userEvent.setup()
    render(<ServiceSpecsSection serviceId={42} peptides={[]} />)
    await screen.findByText('Specs (2)')

    fireEvent.click(screen.getByRole('combobox', { name: 'Tier' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Form' }))

    // Add stays disabled until a form is picked.
    await user.type(screen.getByLabelText('Max'), '5')
    const addButton = screen.getByRole('button', { name: /add spec/i })
    expect(addButton).toBeDisabled()

    fireEvent.click(screen.getByRole('combobox', { name: 'Form' }))
    // Inactive forms stay pickable, flagged.
    expect(
      await screen.findByRole('option', { name: 'Old Form (inactive)' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'Nasal Spray' }))

    await waitFor(() => expect(addButton).not.toBeDisabled())
    await user.click(addButton)

    await waitFor(() => {
      expect(createServiceSpec).toHaveBeenCalledWith(
        42,
        expect.objectContaining({
          sample_form_id: 7,
          matrix: null,
          peptide_id: null,
        })
      )
    })
  })

  it('non-form tiers send sample_form_id: null', async () => {
    const { createServiceSpec } = await import('@/lib/api')
    vi.mocked(createServiceSpec).mockClear()
    const user = userEvent.setup()
    render(<ServiceSpecsSection serviceId={42} peptides={[]} />)
    await screen.findByText('Specs (2)')

    await user.type(screen.getByLabelText('Max'), '5')
    await user.click(screen.getByRole('button', { name: /add spec/i }))

    await waitFor(() => {
      expect(createServiceSpec).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ sample_form_id: null })
      )
    })
  })

  it('tier chip shows the form name', async () => {
    const { listServiceSpecs } = await import('@/lib/api')
    const base = specs.find(s => s.id === 1)
    if (!base) throw new Error('expected the range spec fixture')
    const formSpec: AnalysisServiceSpecRecord = {
      ...base,
      id: 4,
      sample_form_id: 7,
      sample_form_name: 'Nasal Spray',
    }
    expect(tierChip(formSpec)).toBe('Nasal Spray')
    expect(tierChip({ ...formSpec, peptide_code: 'BPC-157' })).toBe('BPC-157')

    vi.mocked(listServiceSpecs).mockResolvedValueOnce([formSpec])
    render(<ServiceSpecsSection serviceId={42} peptides={[]} />)
    const row = (await screen.findAllByRole('row'))[1]
    if (!row) throw new Error('expected a data row')
    expect(within(row).getByText('Nasal Spray')).toBeInTheDocument()
  })

  it('ruleLabel informational with loq reads "As measured · LOQ 3.2"', () => {
    const base = specs[0]
    if (!base) throw new Error('expected a spec fixture')
    const info = {
      ...base,
      rule_kind: 'informational' as const,
      max_value: null,
    }
    expect(ruleLabel({ ...info, loq: '3.2' })).toBe('As measured · LOQ 3.2')
    expect(ruleLabel({ ...info, loq: '3.2', display_override: 'ND' })).toBe(
      'As measured · LOQ 3.2 · ND'
    )
    // No loq: unchanged (ServiceEndoJudgedPanel passes loq: null).
    expect(ruleLabel({ ...info, loq: null })).toBe('As measured')
    expect(ruleLabel({ ...info, loq: null, display_override: 'ND' })).toBe(
      'As measured · ND'
    )
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
