import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as Api from '@/lib/api'
import type { HplcMethod, MethodRunParameters } from '@/lib/api'
import { HPLC_RUN_PARAM_DEFAULTS } from '@/lib/hplc-run-params'
import { MethodRunParamsSection } from '@/components/hplc/MethodRunParamsSection'

const updateMethod = vi.fn()
const noop = vi.fn()
vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof Api>()),
  updateMethod: (...args: unknown[]) => updateMethod(...args),
}))

const HPLC_FIELDS: [keyof typeof HPLC_RUN_PARAM_DEFAULTS, string][] = [
  ['default_target_ug_ml', 'Default target (ug/mL)'],
  ['intermediate_target_ug_ml', 'Intermediate target (ug/mL)'],
  ['intermediate_volume_ul', 'Intermediate volume (uL)'],
  ['two_step_threshold_mg', 'Two-step from (mg)'],
  ['bac_stock_ug_ml', 'Bac water stock (ug/mL)'],
  ['bac_target_ug_ml', 'Bac water target (ug/mL)'],
  ['capsule_neat_max_ug_ml', 'Capsule neat limit (ug/mL)'],
  ['diluent_density_mg_ml', 'Diluent density (mg/mL)'],
  ['benzyl_alcohol_density_mg_ml', 'Benzyl alcohol density (mg/mL)'],
  ['floor_ug_ml', 'Blend floor (ug/mL)'],
  ['target_volume_ul', 'Target volume (uL)'],
  ['sample_diluent_ul', 'Diluent to add (uL)'],
  ['volume_tolerance_pct', 'Volume tolerance (%)'],
]

const ALL_HPLC_NULL = Object.fromEntries(HPLC_FIELDS.map(([k]) => [k, null]))

function method(
  run_parameters: MethodRunParameters | null,
  status: HplcMethod['status'] = 'draft'
): HplcMethod {
  return { id: 7, status, run_parameters } as HplcMethod
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

async function save() {
  fireEvent.click(screen.getByRole('button', { name: /save run parameters/i }))
  await waitFor(() => expect(updateMethod).toHaveBeenCalledTimes(1))
}

describe('MethodRunParamsSection', () => {
  beforeEach(() => {
    updateMethod.mockReset()
    updateMethod.mockResolvedValue({})
  })

  it('lists the thirteen HPLC constants with their defaults as placeholders', () => {
    render(
      <MethodRunParamsSection
        method={method(null)}
        onUpdated={noop}
        block="hplc"
      />
    )
    expect(screen.getAllByRole('textbox')).toHaveLength(13)
    for (const [key, label] of HPLC_FIELDS) {
      expect(screen.getByLabelText(label)).toHaveAttribute(
        'placeholder',
        String(HPLC_RUN_PARAM_DEFAULTS[key])
      )
    }
  })

  it('saving the hplc block keeps an endotoxin block already on the method', async () => {
    render(
      <MethodRunParamsSection
        method={method({ endotoxin: { cv_limit_pct: 20 } })}
        onUpdated={noop}
        block="hplc"
      />
    )
    type('Default target (ug/mL)', '250')
    await save()
    expect(updateMethod).toHaveBeenCalledWith(7, {
      run_parameters: {
        endotoxin: { cv_limit_pct: 20 },
        hplc: { ...ALL_HPLC_NULL, default_target_ug_ml: 250 },
      },
    })
  })

  it('saving the endotoxin block keeps an hplc block already on the method', async () => {
    render(
      <MethodRunParamsSection
        method={method({ hplc: { floor_ug_ml: 50 } })}
        onUpdated={noop}
      />
    )
    type('CV limit (%)', '30')
    await save()
    expect(updateMethod).toHaveBeenCalledWith(7, {
      run_parameters: {
        hplc: { floor_ug_ml: 50 },
        endotoxin: { cv_limit_pct: 30 },
      },
    })
  })

  it('saving the endotoxin block with no hplc block sends what it always sent', async () => {
    render(
      <MethodRunParamsSection
        method={method({ endotoxin: { cv_limit_pct: 20 } })}
        onUpdated={noop}
      />
    )
    type('CV limit (%)', '')
    await save()
    expect(updateMethod).toHaveBeenCalledWith(7, { run_parameters: null })
  })

  it('a cleared field is sent as null, so the default comes back', async () => {
    render(
      <MethodRunParamsSection
        method={method({
          hplc: { floor_ug_ml: 50, default_target_ug_ml: 250 },
        })}
        onUpdated={noop}
        block="hplc"
      />
    )
    type('Blend floor (ug/mL)', '')
    await save()
    expect(updateMethod).toHaveBeenCalledWith(7, {
      run_parameters: {
        hplc: { ...ALL_HPLC_NULL, default_target_ug_ml: 250 },
      },
    })
  })

  it('sends nothing for a method that is not a draft', () => {
    render(
      <MethodRunParamsSection
        method={method({ hplc: { floor_ug_ml: 50 } }, 'active')}
        onUpdated={noop}
        block="hplc"
      />
    )
    expect(
      screen.queryByRole('button', { name: /save run parameters/i })
    ).toBeNull()
    expect(screen.getByLabelText('Blend floor (ug/mL)')).toBeDisabled()
    expect(screen.getByText(/changes need a new revision/i)).toBeInTheDocument()
    expect(updateMethod).not.toHaveBeenCalled()
  })
})
