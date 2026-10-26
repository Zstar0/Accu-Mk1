import { beforeEach, describe, it, expect, vi } from 'vitest'
import {
  fireEvent,
  render,
  screen,
  type RenderOptions,
} from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { useUIStore } from '@/store/ui-store'
import type { WorksheetListItem } from '@/lib/api'
import { ENDO_RUN_PARAM_DEFAULTS } from '@/lib/endo-prep-2ml'
import type { EndoRow } from '@/lib/endo-worksheet-2ml'
import type * as UseFlags from '@/hooks/use-flags'
import type * as FlagTypes from '@/services/flag-types'
import {
  EndoWorksheetTable,
  type EndoTwoMl,
} from '@/components/hplc/EndoWorksheetTable'

// The flag cell, the reassign menu and the SLA badge read live data, and the
// lab calendar is a query; none of them is under test here.
vi.mock('@/hooks/use-lab-calendar', () => ({
  useLabCalendar: () => ({ calendar: null, isLoading: false }),
}))
vi.mock('@/hooks/use-flags', async importOriginal => ({
  ...(await importOriginal<typeof UseFlags>()),
  useEntityFlags: () => ({ data: [] }),
}))
vi.mock('@/services/flag-types', async importOriginal => ({
  ...(await importOriginal<typeof FlagTypes>()),
  useFlagTypesMap: () => ({}),
}))
vi.mock('@/components/flags/RaiseFlagButton', () => ({
  RaiseFlagButton: () => null,
}))
vi.mock('@/components/hplc/ReassignButton', () => ({
  ReassignButton: () => null,
}))
vi.mock('@/components/hplc/SlaAgeIndicator', () => ({
  SlaAgeIndicator: () => null,
}))

type Item = WorksheetListItem['items'][number]

const ITEM = {
  id: 10,
  sample_id: 'P-0001-S01',
  sample_uid: 'mk1://endo-10',
  assignment_role: 'endo',
  analyses: [],
  priority: 'normal',
  prep_status: 'ready',
  date_received: null,
  declared_weight_mg: 10,
  sample_identity: 'BPC-157',
  client_order_number: 'WP-9001',
  lims_sub_sample_pk: 10,
} as unknown as Item

const ROW: EndoRow = {
  item: ITEM,
  n: 1,
  sample: {
    sampleId: 'P-0001-S01',
    identity: 'BPC-157',
    sampleType: null,
    weightMg: 10,
    form: null,
    waterMl: null,
    totalDilution: null,
    steps: null,
    lambda: 0.05,
    reading: null,
    reader: null,
  },
  cartridge: { id: 1, sensitivity: 0.05 },
  inherited: { id: 1, sensitivity: 0.05 },
}

const TWO_ML: EndoTwoMl = {
  rows: [ROW],
  ctx: { params: ENDO_RUN_PARAM_DEFAULTS, allowedLambdas: [0.05, 0.01] },
  cartridges: [
    { id: 1, name: 'Endosafe 0.05', sensitivity_eu_ml: 0.05, is_default: true },
    {
      id: 2,
      name: 'Endosafe 0.01',
      sensitivity_eu_ml: 0.01,
      is_default: false,
    },
  ],
}

function renderTable(
  props: Partial<ComponentProps<typeof EndoWorksheetTable>> = {},
  options: RenderOptions = {}
) {
  return render(
    <EndoWorksheetTable
      items={[]}
      isCompleted={false}
      analyst={null}
      createdAt={null}
      users={[]}
      slaByKey={new Map()}
      slaLoading={false}
      slaError={false}
      otherWorksheets={[]}
      onRemove={vi.fn()}
      onReassign={vi.fn()}
      onUpdateItem={vi.fn()}
      onTickAll={vi.fn()}
      {...props}
    />,
    options
  )
}

const headers = () =>
  screen.getAllByRole('columnheader').map(th => th.textContent)

// Today's columns, verbatim: the flyout and every stock worksheet keep them.
const STOCK = [
  '',
  'Received',
  'DueSLA',
  'Priority',
  'Order #',
  'Sample ID',
  'Sample identity',
  'Targetmg/mL',
  'Declared wtmg',
  'Volume to addmL',
  'Sample neededµL',
  'LAL neededµL',
  'Vial conc.mg/mL',
  'Status',
  'Made',
  'MCS',
  'Flag',
  '',
]
// Spec 2026-10-10 6.1, Box 1 on a 2 mL run.
const TWO = [
  '',
  'Received',
  'DueSLA',
  'Priority',
  'Order #',
  'Sample ID',
  'Sample identity',
  'Declared wtmg',
  'Form',
  'Reconstitution watermL',
  'Vial conc.mg/mL',
  'Cartridgeλ EU/mL',
  'Status',
  'Made',
  'MCS',
  'Flag',
  '',
]

describe('Box 1 columns', () => {
  it("stock keeps today's columns, with or without 2 mL data passed", () => {
    const first = renderTable()
    expect(headers()).toEqual(STOCK)
    expect(screen.getByText(/Sample volume/)).toBeInTheDocument()
    first.unmount()
    renderTable({ twoMl: TWO_ML })
    expect(headers()).toEqual(STOCK)
  })

  it('2 mL swaps Target, Volume to add, Sample needed and LAL needed for Form, Water and Cartridge', () => {
    renderTable({ prepModel: '2ml', twoMl: TWO_ML })
    expect(headers()).toEqual(TWO)
    expect(screen.queryByText(/Sample volume/)).toBeNull()
  })
})

const formPicker = () =>
  screen.getByRole('combobox', { name: 'Form the vial arrived in' })
const cartridgePicker = () =>
  screen.getByRole('combobox', { name: 'Cartridge for this sample' })

// Radix Select under jsdom: fireEvent, not userEvent (no hasPointerCapture),
// as worksheet-apply-method.test.tsx does.
async function pick(trigger: HTMLElement, option: string) {
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('option', { name: option }))
}

/** TWO_ML with the row's own cartridge pick. */
function withOwnCartridge(id: number, sensitivity: number): EndoTwoMl {
  const item = {
    ...ITEM,
    cartridge_type_id: id,
    cartridge_sensitivity_eu_ml: sensitivity,
  }
  return {
    ...TWO_ML,
    rows: [{ ...ROW, item, cartridge: { id, sensitivity } }],
  }
}

describe('Box 1 on a 2 mL row', () => {
  it('shows the form, the water, the vial concentration and the cartridge with MVD and MVC', () => {
    renderTable({ items: [ITEM], prepModel: '2ml', twoMl: TWO_ML })
    expect(formPicker()).toHaveTextContent(/^Lyophilized$/)
    expect(
      (screen.getByLabelText('Water (mL)') as HTMLInputElement).value
    ).toBe('2')
    expect(screen.getByText('5')).toBeInTheDocument() // 10 mg in 2 mL
    // Dennis's figures for 10 mg in 2 mL on the 0.05: MVD (350 / 2) / 0.05, MVC 0.05 x 10 / 350.
    expect(screen.getByText('MVD 3500× · MVC 0.0014')).toBeInTheDocument()
    expect(cartridgePicker()).toHaveTextContent(/^run \(0\.05\)$/)
  })

  it('saves the form and the row cartridge through the item PATCH', async () => {
    const onUpdateItem = vi.fn()
    renderTable({
      items: [ITEM],
      prepModel: '2ml',
      twoMl: TWO_ML,
      onUpdateItem,
    })
    await pick(formPicker(), 'Liquid (reconstituted)')
    // The water goes with the old form (2026-10-19).
    expect(onUpdateItem).toHaveBeenCalledWith(10, {
      prep_form: 'liquid',
      prep_water_ml: null,
    })
    fireEvent.click(cartridgePicker())
    expect(
      (await screen.findAllByRole('option')).map(o => o.textContent)
    ).toEqual(['run (0.05)', '0.05', '0.01'])
    fireEvent.click(screen.getByRole('option', { name: '0.01' }))
    expect(onUpdateItem).toHaveBeenCalledWith(10, { cartridge_type_id: 2 })
  })

  it("sends null to go back to the run's cartridge, and keeps a retired pick visible", async () => {
    const onUpdateItem = vi.fn()
    const twoMl = withOwnCartridge(2, 0.01)
    const view = renderTable({
      items: [twoMl.rows[0]?.item ?? ITEM],
      prepModel: '2ml',
      twoMl,
      onUpdateItem,
    })
    expect(cartridgePicker()).toHaveTextContent(/^0\.01$/)
    await pick(cartridgePicker(), 'run (0.05)')
    expect(onUpdateItem).toHaveBeenCalledWith(10, { cartridge_type_id: null })
    view.unmount()

    const retired = withOwnCartridge(4, 0.02)
    renderTable({
      items: [retired.rows[0]?.item ?? ITEM],
      prepModel: '2ml',
      twoMl: retired,
    })
    expect(cartridgePicker()).toHaveTextContent(/^0\.02 \(not in the list\)$/)
  })

  it('a completed run cannot change the form or the cartridge', () => {
    renderTable({
      items: [ITEM],
      prepModel: '2ml',
      twoMl: TWO_ML,
      isCompleted: true,
    })
    expect(formPicker()).toBeDisabled()
    expect(cartridgePicker()).toBeDisabled()
  })
})

describe('Box 1 links', () => {
  beforeEach(() =>
    useUIStore.setState({
      activeSubSection: 'worksheet',
      sampleDetailsTargetId: null,
      orderStatusPrefill: null,
    })
  )

  // A clickable row around the table: a link's click must never reach it.
  const onRow = vi.fn()
  const row = ({ children }: { children: ReactNode }) => (
    <div onClick={onRow}>{children}</div>
  )

  it('the vial ID opens the sub-sample and its parent ID the sample', () => {
    renderTable({ items: [ITEM] }, { wrapper: row })
    fireEvent.click(screen.getByRole('button', { name: /^P-0001-S01/ }))
    expect(useUIStore.getState().activeSubSection).toBe('sample-details')
    expect(useUIStore.getState().sampleDetailsTargetId).toBe('P-0001-S01')
    fireEvent.click(screen.getByRole('button', { name: 'P-0001' }))
    expect(useUIStore.getState().sampleDetailsTargetId).toBe('P-0001')
    expect(onRow).not.toHaveBeenCalled()
  })

  it('the order # (row and meta strip) opens Order Status on that order', () => {
    renderTable({ items: [ITEM] }, { wrapper: row })
    const links = screen.getAllByRole('button', { name: 'Order 9001' })
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(link).toHaveTextContent(/^9001$/)
      useUIStore.setState({ orderStatusPrefill: null })
      fireEvent.click(link)
      expect(useUIStore.getState().activeSubSection).toBe('order-status')
      expect(useUIStore.getState().orderStatusPrefill).toEqual({
        orderId: '9001',
      })
    }
    expect(onRow).not.toHaveBeenCalled()
  })

  it('a row without an order keeps the plain dash', () => {
    renderTable({ items: [{ ...ITEM, client_order_number: null }] })
    expect(
      screen.queryByRole('button', { name: /^Order / })
    ).not.toBeInTheDocument()
  })
})
