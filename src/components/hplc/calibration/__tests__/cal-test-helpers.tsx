import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CalSheet } from '@/lib/api'
import { queryClient as appQueryClient } from '@/lib/query-client'
import type { CalInputs, CalReplicateInputs } from '@/lib/hplc-calibration'
import { useUIStore } from '@/store/ui-store'
import { HplcCalibrationSheetPage } from '../HplcCalibrationSheetPage'

// The shared work_out_sheet fixture (plan 4, Task 2), read at run time.
interface FixtureCase {
  name: string
  inputs: CalInputs | CalReplicateInputs
  replicate_of?: CalInputs
}
const fixture = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../../../backend/tests/fixtures/hplc_calibration_cases.json'
    ),
    'utf8'
  )
) as { cases: FixtureCase[] }

/** The brief's "case N" is the fixture's Nth case, counting from 1. */
export function fixtureCase(n: number): FixtureCase {
  const c = fixture.cases[n - 1]
  if (!c) throw new Error(`no case ${n}`)
  return structuredClone(c)
}

export function makeSheet(
  inputs: CalInputs | CalReplicateInputs,
  over: Partial<CalSheet> = {}
): CalSheet {
  return {
    id: 5,
    version: 1,
    peptide_id: 11,
    peptide_name: 'Retatrutide',
    peptide_abbreviation: 'RETA',
    instrument_id: 2,
    instrument_name: '1290C',
    replicate_of_sheet_id: null,
    replicate_of_name: null,
    curve_id: null,
    curve_name: null,
    curve_is_active: null,
    filed_at: null,
    updated_at: null,
    updated_by_email: null,
    changed_since_filed: false,
    proposed_name: '1290C-20260205-RETA',
    blocking: [],
    inputs,
    effective_inputs: inputs as CalInputs,
    ...over,
  }
}

export function renderSheet(id = 5) {
  useUIStore.setState({ calibrationSheetPageId: id })
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  })
  const view = render(
    <QueryClientProvider client={qc}>
      <HplcCalibrationSheetPage />
    </QueryClientProvider>
  )
  return Object.assign(view, { qc })
}

/** What MainWindowContent.tsx does: the page shows only on its sub-section,
 *  under a div keyed on navigationKey (every navigateTo* may bump it). */
// eslint-disable-next-line react-refresh/only-export-components -- a test helper, never hot-reloaded
function AsInTheApp() {
  const key = useUIStore(s => s.navigationKey)
  const sub = useUIStore(s => s.activeSubSection)
  return (
    <div key={key} className="contents">
      {sub === 'hplc-calibration' ? (
        <HplcCalibrationSheetPage />
      ) : (
        <p>{`Elsewhere: ${sub}`}</p>
      )}
    </div>
  )
}

/** The page as the app shows it: on the calibration sub-section, keyed on
 *  navigationKey, with a client built from the app's own query defaults
 *  (staleTime 5 minutes, retry 1, no refetch on focus). */
export function renderInApp(id: number | null = 5) {
  useUIStore.setState({
    activeSection: 'hplc-analysis',
    activeSubSection: 'hplc-calibration',
    calibrationSheetPageId: id,
  })
  const qc = new QueryClient({
    defaultOptions: appQueryClient.getDefaultOptions(),
  })
  const view = render(
    <QueryClientProvider client={qc}>
      <AsInTheApp />
    </QueryClientProvider>
  )
  return Object.assign(view, { qc })
}

export function typeAndLeave(el: HTMLElement, text: string) {
  fireEvent.focus(el)
  fireEvent.change(el, { target: { value: text } })
  fireEvent.blur(el)
}
