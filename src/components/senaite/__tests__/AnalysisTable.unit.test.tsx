/**
 * Unit dropdown at bench result entry (sample forms, task 11).
 *
 * A native row's unit is set from the sample's form; the analyst can change it
 * from a dropdown beside the result. The unit rides along with the value on
 * submit (`setAnalysisResult(uid, value, unit)`).
 *
 * Rulings pinned here:
 *  - every mk1 submit sends the unit the row SHOWS (when it is one of
 *    `unit_options`), so even an untouched dropdown stores what the analyst saw;
 *  - several options and no form default: the select starts EMPTY and nothing
 *    is saved until a unit is picked (blur and Enter both stand down);
 *  - SENAITE rows never send a unit.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AnalysisTable } from '@/components/senaite/AnalysisTable'
import type { SenaiteAnalysis } from '@/lib/api'

// Radix Select's trigger calls hasPointerCapture on pointerdown; jsdom lacks it.
window.HTMLElement.prototype.hasPointerCapture = vi.fn()

class MockIntersectionObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: MockIntersectionObserver,
})

vi.mock('@/components/ui/sidebar', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@/components/ui/sidebar')>()
  return {
    ...actual,
    useSidebar: () => ({
      state: 'expanded' as const,
      open: true,
      setOpen: vi.fn(),
      openMobile: false,
      setOpenMobile: vi.fn(),
      isMobile: false,
      toggleSidebar: vi.fn(),
    }),
  }
})

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    setAnalysisResult: vi.fn().mockResolvedValue({
      success: true,
      message: 'ok',
      new_review_state: 'to_be_verified',
      keyword: 'CD',
    }),
  }
})

import { setAnalysisResult } from '@/lib/api'

const TITLE = 'Cadmium (Cd)'
const RESULT_LABEL = `Edit result for ${TITLE}`
const UNIT_LABEL = `Unit for ${TITLE}`

const row = (over: Partial<SenaiteAnalysis> = {}): SenaiteAnalysis => ({
  uid: 'mk1:5',
  keyword: 'CD',
  title: TITLE,
  result: null,
  result_type: 'numeric',
  result_options: [],
  unit: 'ppm',
  unit_options: ['ppm', 'µg/mL'],
  default_unit: 'ppm',
  method: null,
  method_uid: null,
  method_options: [],
  instrument: null,
  instrument_uid: null,
  instrument_options: [],
  analyst: null,
  due_date: null,
  review_state: 'unassigned',
  sort_key: null,
  captured: null,
  retested: false,
  service_group_id: null,
  service_group_name: null,
  service_origin: 'mk1',
  ...over,
})

function renderTable(
  analysis: SenaiteAnalysis | SenaiteAnalysis[],
  props: Partial<React.ComponentProps<typeof AnalysisTable>> = {}
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <button>outside</button>
      <AnalysisTable
        analyses={Array.isArray(analysis) ? analysis : [analysis]}
        analyteNameMap={new Map()}
        {...props}
      />
    </QueryClientProvider>
  )
}

const calls = () => vi.mocked(setAnalysisResult).mock.calls
const lastCall = () => calls()[calls().length - 1]

/** Radix needs a pointer-type click to open under jsdom, then pointerup to pick. */
async function pickUnit(unit: string) {
  await userEvent.click(screen.getByLabelText(UNIT_LABEL))
  const option = await screen.findByRole('option', { name: unit })
  fireEvent.pointerUp(option)
  fireEvent.click(option)
}

describe('unit dropdown at bench entry', () => {
  beforeEach(() => vi.mocked(setAnalysisResult).mockClear())

  it('saves the typed value with the picked unit when the analyst picks a unit after typing', async () => {
    const onResultSaved = vi.fn()
    renderTable(row(), { onResultSaved })
    await userEvent.type(screen.getByLabelText(RESULT_LABEL), '2.1')
    await pickUnit('µg/mL')
    await waitFor(() => expect(setAnalysisResult).toHaveBeenCalled())
    // Typing then moving to the trigger must not have saved with the preset unit.
    expect(calls()).toHaveLength(1)
    expect(lastCall()).toEqual(['mk1:5', '2.1', 'µg/mL'])
    expect(calls().some(c => c[2] === 'ppm')).toBe(false)
    expect(onResultSaved).toHaveBeenCalledWith(
      'mk1:5',
      '2.1',
      'to_be_verified',
      'µg/mL'
    )
  })

  it('blur to elsewhere still saves with the preset unit', async () => {
    renderTable(row())
    await userEvent.type(screen.getByLabelText(RESULT_LABEL), '2.1')
    await userEvent.click(screen.getByRole('button', { name: 'outside' }))
    await waitFor(() => expect(setAnalysisResult).toHaveBeenCalledTimes(1))
    expect(lastCall()).toEqual(['mk1:5', '2.1', 'ppm'])
  })

  it('an untouched dropdown still sends the shown unit on Enter', async () => {
    renderTable(row())
    await userEvent.type(screen.getByLabelText(RESULT_LABEL), '2.1{Enter}')
    await waitFor(() => expect(setAnalysisResult).toHaveBeenCalledTimes(1))
    expect(lastCall()).toEqual(['mk1:5', '2.1', 'ppm'])
  })

  it('tabbing through the dropdown without touching it saves once with the preset unit', async () => {
    renderTable(row())
    await userEvent.type(screen.getByLabelText(RESULT_LABEL), '2.1')
    await userEvent.tab() // input -> unit trigger: still one control, no save
    expect(setAnalysisResult).not.toHaveBeenCalled()
    await userEvent.tab() // trigger -> elsewhere: commit
    await waitFor(() => expect(setAnalysisResult).toHaveBeenCalledTimes(1))
    expect(lastCall()).toEqual(['mk1:5', '2.1', 'ppm'])
  })

  it('dismissing the menu without a change saves once with the preset unit', async () => {
    renderTable(row())
    await userEvent.type(screen.getByLabelText(RESULT_LABEL), '2.1')
    await userEvent.click(screen.getByLabelText(UNIT_LABEL))
    await screen.findByRole('option', { name: 'µg/mL' })
    expect(setAnalysisResult).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(setAnalysisResult).toHaveBeenCalledTimes(1))
    expect(lastCall()).toEqual(['mk1:5', '2.1', 'ppm'])
  })

  it('shows a static unit when there is one option', async () => {
    renderTable(row({ unit_options: ['ppm'] }))
    expect(screen.queryByLabelText(UNIT_LABEL)).not.toBeInTheDocument()
    expect(screen.getByText('ppm')).toBeInTheDocument()
    // the displayed unit is still what gets stored
    await userEvent.type(screen.getByLabelText(RESULT_LABEL), '2.1{Enter}')
    await waitFor(() => expect(setAnalysisResult).toHaveBeenCalledTimes(1))
    expect(lastCall()).toEqual(['mk1:5', '2.1', 'ppm'])
  })

  it('sends no unit for SENAITE rows', async () => {
    renderTable(
      row({
        uid: 'a1b2c3d4e5f67890a1b2c3d4e5f67890',
        service_origin: 'senaite',
        default_unit: 'ppm',
      })
    )
    expect(screen.queryByLabelText(UNIT_LABEL)).not.toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(RESULT_LABEL), '2.1{Enter}')
    await waitFor(() => expect(setAnalysisResult).toHaveBeenCalledTimes(1))
    expect(lastCall()?.slice(0, 2)).toEqual([
      'a1b2c3d4e5f67890a1b2c3d4e5f67890',
      '2.1',
    ])
    expect(lastCall()?.[2]).toBeUndefined()
  })

  describe('several options and no form default', () => {
    const noDefault = () => row({ unit: 'ppm', default_unit: null })

    it('starts empty and saves nothing until a unit is picked', async () => {
      renderTable(noDefault())
      expect(screen.getByLabelText(UNIT_LABEL)).toHaveTextContent('Unit')
      expect(screen.getByLabelText(UNIT_LABEL)).not.toHaveTextContent('ppm')
      await userEvent.type(screen.getByLabelText(RESULT_LABEL), '2.1{Enter}')
      await userEvent.click(screen.getByRole('button', { name: 'outside' }))
      expect(setAnalysisResult).not.toHaveBeenCalled()
    })

    it('picking a unit with a typed value saves value plus unit', async () => {
      renderTable(noDefault())
      await userEvent.type(screen.getByLabelText(RESULT_LABEL), '2.1')
      await pickUnit('µg/mL')
      await waitFor(() => expect(setAnalysisResult).toHaveBeenCalledTimes(1))
      expect(lastCall()).toEqual(['mk1:5', '2.1', 'µg/mL'])
    })

    it('a unit picked before typing is remembered for the save', async () => {
      renderTable(noDefault())
      await pickUnit('ppm')
      expect(setAnalysisResult).not.toHaveBeenCalled() // no value yet
      await userEvent.type(screen.getByLabelText(RESULT_LABEL), '2.1{Enter}')
      await waitFor(() => expect(setAnalysisResult).toHaveBeenCalledTimes(1))
      expect(lastCall()).toEqual(['mk1:5', '2.1', 'ppm'])
    })
  })

  describe('editing an existing result', () => {
    const resulted = () =>
      row({ result: '1.5', review_state: 'to_be_verified' })

    it('keeps the static unit in display mode', () => {
      renderTable(resulted())
      expect(screen.queryByLabelText(UNIT_LABEL)).not.toBeInTheDocument()
      expect(screen.getByText('ppm')).toBeInTheDocument()
    })

    it('Enter saves the draft with the stored unit', async () => {
      renderTable(resulted())
      await userEvent.click(screen.getByRole('button', { name: RESULT_LABEL }))
      await userEvent.type(screen.getByLabelText(RESULT_LABEL), '{Enter}')
      await waitFor(() => expect(setAnalysisResult).toHaveBeenCalledTimes(1))
      expect(lastCall()).toEqual(['mk1:5', '1.5', 'ppm'])
    })

    it('Tab saves the draft with the stored unit', async () => {
      renderTable(resulted())
      await userEvent.click(screen.getByRole('button', { name: RESULT_LABEL }))
      await userEvent.type(screen.getByLabelText(RESULT_LABEL), '{Tab}')
      await waitFor(() => expect(setAnalysisResult).toHaveBeenCalledTimes(1))
      expect(lastCall()).toEqual(['mk1:5', '1.5', 'ppm'])
    })

    it('picking a unit saves the draft with the new unit', async () => {
      renderTable(resulted())
      await userEvent.click(screen.getByRole('button', { name: RESULT_LABEL }))
      await pickUnit('µg/mL')
      await waitFor(() => expect(setAnalysisResult).toHaveBeenCalledTimes(1))
      expect(lastCall()).toEqual(['mk1:5', '1.5', 'µg/mL'])
    })

    it('a stored unit outside the options shows an empty select and sends no unit', async () => {
      renderTable(
        row({ result: '1.5', review_state: 'to_be_verified', unit: 'mg/kg' })
      )
      await userEvent.click(screen.getByRole('button', { name: RESULT_LABEL }))
      expect(screen.getByLabelText(UNIT_LABEL)).toHaveTextContent('Unit')
      await userEvent.type(screen.getByLabelText(RESULT_LABEL), '{Enter}')
      await waitFor(() => expect(setAnalysisResult).toHaveBeenCalledTimes(1))
      expect(lastCall()?.slice(0, 2)).toEqual(['mk1:5', '1.5'])
      expect(lastCall()?.[2]).toBeUndefined()
    })
  })

  describe('Tab-advance in editing mode', () => {
    it('stays on a row that needs a unit pick instead of dropping its typed value', async () => {
      const first = row({
        uid: 'mk1:1',
        title: 'Lead (Pb)',
        result: '1.5',
        review_state: 'to_be_verified',
        sort_key: 1,
      })
      const needsPick = row({ uid: 'mk1:2', default_unit: null, sort_key: 2 })
      const last = row({ uid: 'mk1:3', title: 'Arsenic (As)', sort_key: 3 })
      renderTable([first, needsPick, last])

      await userEvent.click(
        screen.getByRole('button', { name: 'Edit result for Lead (Pb)' })
      )
      await userEvent.type(
        screen.getByLabelText('Edit result for Lead (Pb)'),
        '{Tab}'
      )
      // the first row saved, then editing moved on to the row that needs a unit
      await waitFor(() => expect(setAnalysisResult).toHaveBeenCalledTimes(1))
      expect(calls()[0]?.[0]).toBe('mk1:1')
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
      )

      await userEvent.type(screen.getByLabelText(RESULT_LABEL), '2.1{Tab}')
      expect(calls().some(c => c[0] === 'mk1:2')).toBe(false)
      expect(screen.getByLabelText(RESULT_LABEL)).toHaveValue(2.1)
      expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1)
    })
  })
})
