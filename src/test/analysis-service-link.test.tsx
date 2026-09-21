import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  AnalysisServiceTooltip,
  resolveServiceForAnalysis,
  specsForAnalysis,
} from '@/components/senaite/AnalysisServiceLink'
import type {
  AnalysisServiceRecord,
  AnalysisServiceSpecRecord,
  SenaiteAnalysis,
} from '@/lib/api'

const svc = (over: Partial<AnalysisServiceRecord>): AnalysisServiceRecord =>
  ({
    id: 1,
    title: 'HPLC Purity',
    keyword: 'HPLC-PURITY',
    unit: '%',
    origin: 'mk1',
    active: true,
    ...over,
  }) as AnalysisServiceRecord

const spec = (
  over: Partial<AnalysisServiceSpecRecord>
): AnalysisServiceSpecRecord =>
  ({
    id: 1,
    analysis_service_id: 1,
    matrix: null,
    peptide_id: null,
    peptide_code: null,
    rule_kind: 'range',
    min_value: '98',
    max_value: null,
    equals_value: null,
    unit: '%',
    display_override: null,
    loq: null,
    active: true,
    updated_at: null,
    ...over,
  }) as AnalysisServiceSpecRecord

const line = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis =>
  ({ uid: 'mk1:9', keyword: 'HPLC-PURITY', title: 'Purity', ...over }) as SenaiteAnalysis

describe('resolveServiceForAnalysis', () => {
  const services = [
    svc({ id: 1, keyword: 'DUP', origin: 'senaite' }),
    svc({ id: 2, keyword: 'DUP', origin: 'mk1' }),
    svc({ id: 3, keyword: 'SOLO', origin: 'senaite' }),
  ]

  it('prefers the row id over a colliding keyword', () => {
    const hit = resolveServiceForAnalysis(
      { analysis_service_id: 2, keyword: 'DUP', service_origin: null },
      services
    )
    expect(hit?.id).toBe(2)
  })

  it('falls back to a unique keyword for SENAITE rows', () => {
    const hit = resolveServiceForAnalysis({ keyword: 'SOLO' }, services)
    expect(hit?.id).toBe(3)
  })

  it('breaks a keyword collision by origin, defaulting to senaite', () => {
    expect(resolveServiceForAnalysis({ keyword: 'DUP' }, services)?.id).toBe(1)
    expect(
      resolveServiceForAnalysis(
        { keyword: 'DUP', service_origin: 'mk1' },
        services
      )?.id
    ).toBe(2)
  })

  it('resolves nothing when unknown or the catalog is not loaded', () => {
    expect(resolveServiceForAnalysis({ keyword: 'NOPE' }, services)).toBeNull()
    expect(resolveServiceForAnalysis({ keyword: 'SOLO' }, undefined)).toBeNull()
  })
})

describe('specsForAnalysis', () => {
  const specs = [
    spec({ id: 1 }),
    spec({ id: 2, matrix: 'Peptide' }),
    spec({ id: 3, peptide_id: 7, peptide_code: 'BPC-157' }),
    spec({ id: 4, peptide_id: 8, peptide_code: 'TB-500' }),
    spec({ id: 5, active: false }),
  ]

  it("keeps default + matrix rows and only this line's peptide row", () => {
    expect(specsForAnalysis(specs, 7).map(s => s.id)).toEqual([1, 2, 3])
  })

  it('drops every peptide row for an unresolved line', () => {
    expect(specsForAnalysis(specs, null).map(s => s.id)).toEqual([1, 2])
  })
})

describe('AnalysisServiceTooltip', () => {
  it('shows line details and the filed spec rule', () => {
    const { getByTestId } = render(
      <AnalysisServiceTooltip
        analysis={line({ peptide_id: 7, review_state: 'to_be_verified' })}
        service={svc({})}
        specs={[spec({ id: 3, peptide_id: 7, peptide_code: 'BPC-157' })]}
      />
    )
    const text = getByTestId('analysis-service-tooltip').textContent ?? ''
    expect(text).toContain('HPLC Purity')
    expect(text).toContain('HPLC-PURITY')
    expect(text).toContain('Accu-Mk1 (no SENAITE record)')
    expect(text).toContain('to_be_verified')
    expect(text).toContain('BPC-157:')
    expect(text).toContain('≥ 98 %')
  })

  it('shows who produced the result and when it was captured', () => {
    const { getByTestId } = render(
      <AnalysisServiceTooltip
        analysis={line({ analyst: 'F. Parker', captured: '2026-09-21T16:33:26' })}
        service={svc({})}
        specs={[]}
      />
    )
    const text = getByTestId('analysis-service-tooltip').textContent ?? ''
    expect(text).toContain('Analyst: F. Parker')
    expect(text).toMatch(/Captured: Sep 21, 26/)
    // Neither line is printed for a row that has no value yet.
    const empty = render(
      <AnalysisServiceTooltip analysis={line({})} service={svc({})} specs={[]} />
    )
    expect(empty.getAllByTestId('analysis-service-tooltip').at(-1)?.textContent).not.toContain(
      'Captured'
    )
  })

  it('says so when no spec is filed, and when still loading', () => {
    const none = render(
      <AnalysisServiceTooltip analysis={line({})} service={svc({})} specs={[]} />
    )
    expect(none.container.textContent).toContain('No active spec filed')
    const loading = render(
      <AnalysisServiceTooltip
        analysis={line({})}
        service={svc({})}
        specs={undefined}
      />
    )
    expect(loading.container.textContent).toContain('Loading...')
  })
})
