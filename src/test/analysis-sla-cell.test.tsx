import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n/config'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SampleSlaSnapshot } from '@/services/order-sla'
import { AnalysisSlaCell } from '@/components/senaite/AnalysisSlaCell'
import { NO_GROUP_KEY } from '@/lib/sla-resolution'

const TIER = {
  id: 2,
  name: 'HPLC fast',
  target_minutes: 240,
  business_hours_only: false,
  is_default: false,
  amber_threshold_percent: 80,
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-01-01T00:00:00',
}

function makeSnapshot(overrides: Partial<SampleSlaSnapshot> = {}): SampleSlaSnapshot {
  return {
    groupKey: 100,
    groupName: 'HPLC',
    tier: TIER,
    status: { elapsed_minutes: 60, remaining_minutes: 180, target_minutes: 240, breached: false },
    color: 'green',
    reason: { tierSource: 'group', unmappedKeywords: [] },
    priority: 'normal',
    ...overrides,
  } as SampleSlaSnapshot
}

function wrap(node: React.ReactNode) {
  return (
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>{node}</TooltipProvider>
    </I18nextProvider>
  )
}

describe('AnalysisSlaCell', () => {
  it('renders green dot + remaining text for active green snapshot', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={makeSnapshot({ color: 'green' })}
        priority="normal"
        isLoading={false}
        isError={false}
        isPublished={false}
      />
    ))
    const cell = screen.getByTestId('analysis-sla-cell')
    expect(cell).toHaveAttribute('data-sla-color', 'green')
    expect(cell.textContent).toMatch(/3h.*left/i)
  })

  it('renders amber dot for amber snapshot', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={makeSnapshot({ color: 'amber', status: { elapsed_minutes: 200, remaining_minutes: 40, target_minutes: 240, breached: false } })}
        priority="normal"
        isLoading={false}
        isError={false}
        isPublished={false}
      />
    ))
    expect(screen.getByTestId('analysis-sla-cell')).toHaveAttribute('data-sla-color', 'amber')
  })

  it('renders red + "Over Xh" for breached active snapshot', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={makeSnapshot({
          color: 'red',
          status: { elapsed_minutes: 360, remaining_minutes: -120, target_minutes: 240, breached: true },
        })}
        priority="normal"
        isLoading={false}
        isError={false}
        isPublished={false}
      />
    ))
    const cell = screen.getByTestId('analysis-sla-cell')
    expect(cell).toHaveAttribute('data-sla-color', 'red')
    expect(cell.textContent).toMatch(/over/i)
  })

  it('renders "took Xh" for published met snapshot', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={makeSnapshot({
          color: 'green',
          status: { elapsed_minutes: 180, remaining_minutes: 60, target_minutes: 240, breached: false },
        })}
        priority="normal"
        isLoading={false}
        isError={false}
        isPublished={true}
      />
    ))
    const cell = screen.getByTestId('analysis-sla-cell')
    expect(cell).toHaveAttribute('data-sla-color', 'met')
    expect(cell.textContent).toMatch(/took.*\dh/i)
  })

  it('renders "Missed by Xh" for published breached snapshot', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={makeSnapshot({
          color: 'red',
          status: { elapsed_minutes: 600, remaining_minutes: -360, target_minutes: 240, breached: true },
        })}
        priority="normal"
        isLoading={false}
        isError={false}
        isPublished={true}
      />
    ))
    const cell = screen.getByTestId('analysis-sla-cell')
    expect(cell).toHaveAttribute('data-sla-color', 'missed')
  })

  it('renders loading indicator', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={null}
        priority={null}
        isLoading={true}
        isError={false}
        isPublished={false}
      />
    ))
    expect(screen.getByTestId('analysis-sla-cell')).toHaveAttribute('data-sla-color', 'loading')
  })

  it('renders error indicator', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={null}
        priority={null}
        isLoading={false}
        isError={true}
        isPublished={false}
      />
    ))
    expect(screen.getByTestId('analysis-sla-cell')).toHaveAttribute('data-sla-color', 'error')
  })

  it('renders muted em-dash when snapshot is null and no loading/error', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={null}
        priority={null}
        isLoading={false}
        isError={false}
        isPublished={false}
      />
    ))
    const cell = screen.getByTestId('analysis-sla-cell')
    expect(cell).toHaveAttribute('data-sla-color', 'none')
    expect(cell.textContent).toContain('—')
  })

  it('NO_GROUP_KEY snapshot still renders normally (default-tier fallback case)', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={makeSnapshot({ groupKey: NO_GROUP_KEY, groupName: undefined })}
        priority="normal"
        isLoading={false}
        isError={false}
        isPublished={false}
      />
    ))
    expect(screen.getByTestId('analysis-sla-cell')).toHaveAttribute('data-sla-color', 'green')
  })
})
