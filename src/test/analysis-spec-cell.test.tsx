import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  AnalysisSpecCell,
  specDeviation,
  specText,
  specVerdict,
} from '@/components/senaite/AnalysisSpecCell'
import type { AnalysisSpecification } from '@/lib/api'

const spec = (over: Partial<AnalysisSpecification>): AnalysisSpecification => ({
  rule_kind: 'range',
  equals: null,
  min: null,
  max: null,
  unit: null,
  display: null,
  loq: null,
  ...over,
})

const PURITY = spec({ min: 98, unit: '%' })

describe('specText', () => {
  it('words each rule the way the catalog and the certificate do', () => {
    expect(specText(PURITY)).toBe('≥ 98 %')
    expect(specText(spec({ max: 0.5, unit: 'µg/g', loq: 0.1 }))).toBe('≤ 0.5 µg/g · LOQ 0.1')
    expect(specText(spec({ min: 1, max: 5, unit: 'mg' }))).toBe('1 – 5 mg')
    expect(specText(spec({ rule_kind: 'equals', equals: 'Conforms' }))).toBe('= Conforms')
    expect(specText(spec({ rule_kind: 'informational' }))).toBe('As measured')
  })

  it('lets a filed display override win', () => {
    expect(specText(spec({ min: 98, unit: '%', display: 'NLT 98%' }))).toBe('NLT 98%')
  })
})

describe('specVerdict', () => {
  it('reports the backend verdict; the FE never judges', () => {
    // conforms=true is trusted even though 97 < 98: the verdict is the backend's.
    expect(specVerdict({ specification: PURITY, conforms: true, result: '97' })).toEqual({
      label: 'Conforms',
      tone: 'pass',
    })
  })

  it('a failing range shows how far outside the bound it is, like the COA', () => {
    // P-5010: purity 97 against a 98 minimum printed "-1.02%" on the certificate.
    expect(specDeviation(PURITY, '97')).toBe('-1.02%')
    expect(specVerdict({ specification: PURITY, conforms: false, result: '97' })).toEqual({
      label: 'Does not conform · -1.02%',
      tone: 'fail',
    })
    expect(specDeviation(spec({ max: 10 }), '12')).toBe('+20.00%')
  })

  it('a failing equals rule has no deviation', () => {
    const s = spec({ rule_kind: 'equals', equals: 'Conforms' })
    expect(specVerdict({ specification: s, conforms: false, result: 'Does not conform' })).toEqual(
      { label: 'Does not conform', tone: 'fail' }
    )
  })

  it('no verdict: pending, report only, or a rule that could not run', () => {
    expect(specVerdict({ specification: PURITY, conforms: null, result: null })?.label).toBe('Pending')
    expect(
      specVerdict({ specification: spec({ rule_kind: 'informational' }), conforms: null, result: '2' })?.label
    ).toBe('Report only')
    expect(specVerdict({ specification: PURITY, conforms: null, result: 'n/a' })).toEqual({
      label: 'Not evaluated',
      tone: 'warn',
    })
    expect(specVerdict({ specification: null, conforms: null, result: '97' })).toBeNull()
  })
})

describe('AnalysisSpecCell', () => {
  const renderCell = (analysis: Parameters<typeof AnalysisSpecCell>[0]['analysis']) =>
    render(
      <TooltipProvider>
        <AnalysisSpecCell analysis={analysis} />
      </TooltipProvider>
    )

  it('renders the spec over the verdict in one cell', () => {
    renderCell({ specification: PURITY, conforms: false, result: '97', unit: '%' })
    const cell = screen.getByTestId('analysis-spec-cell')
    expect(cell).toHaveAttribute('data-spec-verdict', 'fail')
    expect(cell).toHaveTextContent('≥ 98 %')
    expect(cell).toHaveTextContent('Does not conform · -1.02%')
  })

  it('renders a dash when the service has no spec filed', () => {
    renderCell({ specification: null, conforms: null, result: '97', unit: '%' })
    const cell = screen.getByTestId('analysis-spec-cell')
    expect(cell).toHaveAttribute('data-spec-verdict', 'none')
    expect(cell).toHaveTextContent('–')
  })
})
