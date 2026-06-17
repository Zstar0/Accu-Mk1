import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type {
  PeptideRecord,
  SubSampleListResponse,
  SenaiteLookupResult,
} from '@/lib/api'

// jsdom lacks ResizeObserver; Radix's Switch (Standard Sample toggle) needs it.
class MockResizeObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  configurable: true,
  value: MockResizeObserver,
})
// Radix Select/Switch drive pointer-capture + scrollIntoView APIs jsdom lacks.
window.HTMLElement.prototype.hasPointerCapture = vi.fn()
window.HTMLElement.prototype.setPointerCapture = vi.fn()
window.HTMLElement.prototype.releasePointerCapture = vi.fn()
window.HTMLElement.prototype.scrollIntoView = vi.fn()

// Step1SampleInfo talks to the API via direct fetch-wrapping functions (no
// react-query), so we mock those. The auto-lookup path under test:
//   prefill { sampleId: 'P-0151-S01', autoLookup: true }
//     → effect waits for the async getSenaiteStatus to resolve enabled
//     → fires handleLookup('P-0151-S01') → isVial branch → lookupSenaiteSample('P-0151')
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getPeptides: vi.fn(),
    getInstruments: vi.fn(),
    getSenaiteStatus: vi.fn(),
    lookupSenaiteSample: vi.fn(),
    listSubSamples: vi.fn(),
    createWizardSession: vi.fn(),
    updateWizardSession: vi.fn(),
  }
})

import {
  getPeptides,
  getInstruments,
  getSenaiteStatus,
  lookupSenaiteSample,
  listSubSamples,
} from '@/lib/api'
import { Step1SampleInfo } from '@/components/hplc/wizard/steps/Step1SampleInfo'
import { useUIStore } from '@/store/ui-store'
import { useWizardStore } from '@/store/wizard-store'

const PEPTIDE = {
  id: 1,
  name: 'BPC-157',
  abbreviation: 'BPC-157',
  is_blend: false,
  components: [],
  prep_vial_count: 1,
  analyte_class: 'peptide',
} as unknown as PeptideRecord

const SUBS = {
  parent: { sample_id: 'P-0151' },
  sub_samples: [
    { id: 1, sample_id: 'P-0151-S01', assignment_role: 'hplc', assignment_kind: 'core' },
  ],
} as unknown as SubSampleListResponse

const LOOKUP = {
  sample_id: 'P-0151',
  declared_weight_mg: null,
  analytes: [],
} as unknown as SenaiteLookupResult

beforeEach(() => {
  vi.clearAllMocks()
  useWizardStore.getState().resetWizard()
  useUIStore.getState().clearWorksheetPrepPrefill()
  vi.mocked(getPeptides).mockResolvedValue([PEPTIDE])
  vi.mocked(getInstruments).mockResolvedValue([])
  vi.mocked(listSubSamples).mockResolvedValue(SUBS)
  vi.mocked(lookupSenaiteSample).mockResolvedValue(LOOKUP)
})

describe('Step1SampleInfo auto-lookup (sub-sample New Analysis shortcut)', () => {
  it('auto-fires the vial lookup once the async SENAITE status resolves', async () => {
    // getSenaiteStatus resolves asynchronously → checkingStatus starts true,
    // proving the effect waits for status rather than racing it.
    vi.mocked(getSenaiteStatus).mockResolvedValue({ enabled: true })

    useUIStore.getState().startPrepFromWorksheet({
      sampleId: 'P-0151-S01',
      peptideId: null,
      method: null,
      instrumentId: null,
      autoLookup: true,
    })

    render(<Step1SampleInfo />)

    // Derived the parent and took the isVial branch (parent id, not the vial id).
    await waitFor(() => {
      expect(lookupSenaiteSample).toHaveBeenCalledWith('P-0151')
    })
    // listSubSamples is queried with the parent id to resolve the vial pk.
    expect(listSubSamples).toHaveBeenCalledWith('P-0151')
  })

  it('does not fire a lookup when SENAITE is disabled (no lookup tab)', async () => {
    vi.mocked(getSenaiteStatus).mockResolvedValue({ enabled: false })

    useUIStore.getState().startPrepFromWorksheet({
      sampleId: 'P-0151-S01',
      peptideId: null,
      method: null,
      instrumentId: null,
      autoLookup: true,
    })

    render(<Step1SampleInfo />)

    // Let peptides + status settle; the pending intent is dropped, no lookup.
    await waitFor(() => expect(getPeptides).toHaveBeenCalled())
    await Promise.resolve()
    expect(lookupSenaiteSample).not.toHaveBeenCalled()
  })

  it('does not auto-fire without the autoLookup flag (plain navigation)', async () => {
    vi.mocked(getSenaiteStatus).mockResolvedValue({ enabled: true })

    useUIStore.getState().startPrepFromWorksheet({
      sampleId: 'P-0151-S01',
      peptideId: null,
      method: null,
      instrumentId: null,
      // autoLookup omitted
    })

    render(<Step1SampleInfo />)

    await waitFor(() => expect(getPeptides).toHaveBeenCalled())
    await Promise.resolve()
    expect(lookupSenaiteSample).not.toHaveBeenCalled()
  })
})
