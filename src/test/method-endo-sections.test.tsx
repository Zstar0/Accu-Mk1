import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as Api from '@/lib/api'
import type {
  ConsumableKind,
  ConsumableType,
  HplcMethod,
  MethodConsumableLink,
} from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof Api>()
  return {
    ...actual,
    getMethodConsumables: vi.fn(),
    putMethodConsumables: vi.fn(),
    listConsumables: vi.fn(),
    listConsumableKinds: vi.fn(),
    updateMethod: vi.fn(),
    // MethodPanel's own loads, for the mount test
    getMethods: vi.fn(),
    getInstruments: vi.fn(),
    getDepartments: vi.fn(),
    getAnalysisServices: vi.fn(),
    getMethodServices: vi.fn(),
    putMethodServices: vi.fn(),
    getPeptides: vi.fn(),
    getMethodAttachments: vi.fn(),
  }
})

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import {
  getAnalysisServices,
  getDepartments,
  getInstruments,
  getMethodAttachments,
  getMethodConsumables,
  getMethodServices,
  getMethods,
  getPeptides,
  listConsumableKinds,
  listConsumables,
  putMethodConsumables,
  updateMethod,
} from '@/lib/api'
import { MethodConsumablesSection } from '@/components/hplc/MethodConsumablesSection'
import { MethodRunParamsSection } from '@/components/hplc/MethodRunParamsSection'
import { MethodPanel } from '@/components/hplc/MethodPanel'

const method = (over: Partial<HplcMethod> = {}): HplcMethod =>
  ({
    id: 7,
    name: 'Endotoxin',
    status: 'draft',
    revision: 2,
    supersedes_id: null,
    senaite_id: null,
    instrument_ids: [],
    instruments: [],
    services: [],
    common_peptides: [],
    run_parameters: null,
    ...over,
  }) as HplcMethod

const KIND: ConsumableKind = {
  key: 'endo_cartridge',
  label: 'Endotoxin cartridge',
  specs: [
    {
      key: 'sensitivity_eu_ml',
      label: 'Sensitivity',
      unit: 'EU/mL',
      type: 'positive_float',
      required: true,
    },
  ],
}
const cart = (
  id: number,
  name: string,
  sens: number,
  active = true
): ConsumableType => ({
  id,
  kind: 'endo_cartridge',
  name,
  manufacturer: null,
  part_number: null,
  instrument_id: null,
  specs: { sensitivity_eu_ml: sens },
  active,
  in_use: false,
})
const LINKED: MethodConsumableLink[] = [
  { consumable_type_id: 1, kind: 'endo_cartridge', is_default: true },
]

describe('MethodConsumablesSection', () => {
  beforeEach(() => {
    vi.mocked(getMethodConsumables).mockReset().mockResolvedValue(LINKED)
    vi.mocked(listConsumables)
      .mockReset()
      .mockResolvedValue([
        cart(1, 'Endosafe 0.05', 0.05),
        cart(2, 'Endosafe 0.01', 0.01),
        cart(3, 'Endosafe old', 0.02, false),
      ])
    vi.mocked(listConsumableKinds).mockReset().mockResolvedValue([KIND])
    vi.mocked(putMethodConsumables)
      .mockReset()
      .mockImplementation(async (_id, links) =>
        links.map(l => ({ ...l, kind: 'endo_cartridge' }))
      )
  })

  it('on a draft, adds an active type and moves the default within its kind', async () => {
    const user = userEvent.setup()
    render(<MethodConsumablesSection method={method()} onUpdated={vi.fn()} />)
    expect(await screen.findByText('Endosafe 0.05')).toBeInTheDocument()

    const add = screen.getByLabelText('Add Endotoxin cartridge')
    expect(
      Array.from(add.querySelectorAll('option')).map(o => o.value)
    ).toEqual(['', '2']) // the retired type is never offered
    await user.selectOptions(add, '2')
    await waitFor(() =>
      expect(putMethodConsumables).toHaveBeenLastCalledWith(7, [
        { consumable_type_id: 1, is_default: true },
        { consumable_type_id: 2, is_default: false },
      ])
    )

    await user.click(await screen.findByLabelText('Default: Endosafe 0.01'))
    await waitFor(() =>
      expect(putMethodConsumables).toHaveBeenLastCalledWith(7, [
        { consumable_type_id: 1, is_default: false },
        { consumable_type_id: 2, is_default: true },
      ])
    )
  })

  it('on an issued method, lists the types read-only', async () => {
    render(
      <MethodConsumablesSection
        method={method({ status: 'active' })}
        onUpdated={vi.fn()}
      />
    )
    expect(await screen.findByText('Endosafe 0.05')).toBeInTheDocument()
    expect(screen.getByText('Changes need a new revision')).toBeInTheDocument()
    expect(screen.getByText('Default')).toBeInTheDocument()
    expect(screen.queryByLabelText('Add Endotoxin cartridge')).toBeNull()
    expect(screen.queryByLabelText('Remove Endosafe 0.05')).toBeNull()
  })

  // A new revision copies links even to types retired since, and the PUT
  // refuses a retired type (400): flag them and leave them out of every save.
  it('flags a retired link and drops it from the next save', async () => {
    const user = userEvent.setup()
    vi.mocked(getMethodConsumables).mockResolvedValue([
      {
        consumable_type_id: 3,
        kind: 'endo_cartridge',
        is_default: true,
        name: 'Endosafe old',
        specs: { sensitivity_eu_ml: 0.02 },
        active: false,
      },
    ])
    render(<MethodConsumablesSection method={method()} onUpdated={vi.fn()} />)
    expect(await screen.findByText('Endosafe old')).toBeInTheDocument()
    expect(screen.getByText('Retired')).toBeInTheDocument()
    expect(screen.getByText(/dropped on the next save/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Default: Endosafe old')).toBeDisabled()

    await user.selectOptions(
      screen.getByLabelText('Add Endotoxin cartridge'),
      '2'
    )
    await waitFor(() =>
      expect(putMethodConsumables).toHaveBeenLastCalledWith(7, [
        { consumable_type_id: 2, is_default: true },
      ])
    )
  })

  it("shows the server's refusal in the section", async () => {
    const user = userEvent.setup()
    vi.mocked(putMethodConsumables).mockRejectedValue(
      new Error(
        "method 'Endotoxin' rev 2 is locked (status draft, or used by analyses); consumables change only on an unused draft. Create a new revision instead"
      )
    )
    render(<MethodConsumablesSection method={method()} onUpdated={vi.fn()} />)
    await user.selectOptions(
      await screen.findByLabelText('Add Endotoxin cartridge'),
      '2'
    )
    expect(
      await screen.findByText(/Create a new revision instead/)
    ).toBeInTheDocument()
  })
})

describe('MethodRunParamsSection', () => {
  beforeEach(() => {
    vi.mocked(updateMethod).mockReset().mockResolvedValue(method())
  })

  it("shows Dennis's values as placeholders and saves only what is typed", async () => {
    const user = userEvent.setup()
    render(<MethodRunParamsSection method={method()} onUpdated={vi.fn()} />)
    const placeholders: [string, string][] = [
      ['Standard total dilution (1:N)', '250'],
      ['Reconstitution water (mL)', '2'],
      ['Spike recovery min (%)', '50'],
      ['Spike recovery max (%)', '200'],
      ['CV limit (%)', '25'],
    ]
    for (const [label, value] of placeholders)
      expect(screen.getByLabelText(label)).toHaveAttribute('placeholder', value)

    await user.type(
      screen.getByLabelText('Standard total dilution (1:N)'),
      '300'
    )
    await user.click(
      screen.getByRole('button', { name: /save run parameters/i })
    )
    await waitFor(() =>
      expect(updateMethod).toHaveBeenCalledWith(7, {
        run_parameters: { endotoxin: { std_total_dilution: 300 } },
      })
    )
  })

  it('clearing every value sends null', async () => {
    const user = userEvent.setup()
    render(
      <MethodRunParamsSection
        method={method({ run_parameters: { endotoxin: { cv_limit_pct: 30 } } })}
        onUpdated={vi.fn()}
      />
    )
    await user.clear(screen.getByLabelText('CV limit (%)'))
    await user.click(
      screen.getByRole('button', { name: /save run parameters/i })
    )
    await waitFor(() =>
      expect(updateMethod).toHaveBeenCalledWith(7, { run_parameters: null })
    )
  })

  it('is read-only on an issued method', () => {
    render(
      <MethodRunParamsSection
        method={method({ status: 'active' })}
        onUpdated={vi.fn()}
      />
    )
    expect(screen.getByLabelText('CV limit (%)')).toBeDisabled()
    expect(screen.getByText('Changes need a new revision')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /save run parameters/i })
    ).toBeNull()
  })

  it("shows the server's refusal in the section", async () => {
    const user = userEvent.setup()
    vi.mocked(updateMethod).mockRejectedValue(
      new Error(
        "method 'Endotoxin' rev 2 is issued, locked fields: run_parameters; create a new revision instead"
      )
    )
    render(<MethodRunParamsSection method={method()} onUpdated={vi.fn()} />)
    await user.type(screen.getByLabelText('CV limit (%)'), '30')
    await user.click(
      screen.getByRole('button', { name: /save run parameters/i })
    )
    expect(
      await screen.findByText(/create a new revision instead/)
    ).toBeInTheDocument()
  })
})

describe('MethodPanel', () => {
  beforeEach(() => {
    vi.mocked(getMethods).mockReset().mockResolvedValue([])
    vi.mocked(getInstruments).mockReset().mockResolvedValue([])
    vi.mocked(getDepartments).mockReset().mockResolvedValue([])
    vi.mocked(getAnalysisServices).mockReset().mockResolvedValue([])
    vi.mocked(getPeptides).mockReset().mockResolvedValue([])
    vi.mocked(getMethodAttachments).mockReset().mockResolvedValue([])
    vi.mocked(getMethodConsumables).mockReset().mockResolvedValue([])
    vi.mocked(listConsumables).mockReset().mockResolvedValue([])
    vi.mocked(listConsumableKinds).mockReset().mockResolvedValue([KIND])
  })

  it('shows both sections on a method that covers an endotoxin service', async () => {
    vi.mocked(getMethodServices)
      .mockReset()
      .mockResolvedValue([
        {
          analysis_service_id: 5,
          keyword: 'ENDO-LAL',
          title: 'Endotoxin',
          is_default: true,
        },
      ])
    render(<MethodPanel method={method()} onUpdated={vi.fn()} />)
    expect(
      await screen.findByText('Run parameters (endotoxin)')
    ).toBeInTheDocument()
    expect(screen.getByText(/^Consumables \(/)).toBeInTheDocument()
  })

  it('leaves other methods as they are', async () => {
    vi.mocked(getMethodServices)
      .mockReset()
      .mockResolvedValue([
        {
          analysis_service_id: 6,
          keyword: 'PUR-HPLC',
          title: 'Purity',
          is_default: true,
        },
      ])
    render(
      <MethodPanel
        method={method({ name: 'HPLC purity' })}
        onUpdated={vi.fn()}
      />
    )
    expect(await screen.findByText('PUR-HPLC')).toBeInTheDocument()
    expect(screen.queryByText('Run parameters (endotoxin)')).toBeNull()
  })
})
