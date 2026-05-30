import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n/config'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SlaSubjectSnapshot } from '@/services/sla-subjects'
import { SlaAgeIndicator } from '@/components/hplc/SlaAgeIndicator'

const TIER = {
  id: 2, name: 'HPLC fast', target_minutes: 240, business_hours_only: false,
  is_default: false, amber_threshold_percent: 80,
  created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00',
}

function snap(over: Partial<SlaSubjectSnapshot> = {}): SlaSubjectSnapshot {
  return {
    key: 'k',
    status: { elapsed_minutes: 60, remaining_minutes: 180, target_minutes: 240, breached: false },
    color: 'green',
    tier: TIER,
    priority: 'normal',
    groupId: 100,
    groupName: 'HPLC',
    isFrozen: false,
    ...over,
  } as SlaSubjectSnapshot
}

function wrap(node: React.ReactNode) {
  return (
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>{node}</TooltipProvider>
    </I18nextProvider>
  )
}

describe('SlaAgeIndicator', () => {
  it('renders green dot for live green snapshot', () => {
    render(wrap(<SlaAgeIndicator snapshot={snap({ color: 'green' })} isLoading={false} isError={false} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'green')
  })

  it('renders amber dot for live amber snapshot', () => {
    render(wrap(<SlaAgeIndicator snapshot={snap({ color: 'amber', status: { elapsed_minutes: 200, remaining_minutes: 40, target_minutes: 240, breached: false } })} isLoading={false} isError={false} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'amber')
  })

  it('renders red for live breached snapshot', () => {
    render(wrap(<SlaAgeIndicator snapshot={snap({ color: 'red', status: { elapsed_minutes: 360, remaining_minutes: -120, target_minutes: 240, breached: true } })} isLoading={false} isError={false} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'red')
  })

  it('renders met for frozen non-breached snapshot', () => {
    render(wrap(<SlaAgeIndicator snapshot={snap({ isFrozen: true, color: 'green', status: { elapsed_minutes: 180, remaining_minutes: 60, target_minutes: 240, breached: false } })} isLoading={false} isError={false} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'met')
  })

  it('renders missed for frozen breached snapshot', () => {
    render(wrap(<SlaAgeIndicator snapshot={snap({ isFrozen: true, color: 'red', status: { elapsed_minutes: 600, remaining_minutes: -360, target_minutes: 240, breached: true } })} isLoading={false} isError={false} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'missed')
  })

  it('renders loading and error and empty states', () => {
    const { rerender } = render(wrap(<SlaAgeIndicator snapshot={null} isLoading={true} isError={false} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'loading')
    rerender(wrap(<SlaAgeIndicator snapshot={null} isLoading={false} isError={true} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'error')
    rerender(wrap(<SlaAgeIndicator snapshot={null} isLoading={false} isError={false} compact />))
    const cell = screen.getByTestId('sla-age-indicator')
    expect(cell).toHaveAttribute('data-sla-color', 'none')
    expect(cell.textContent).toContain('—')
  })

  it('renders the worst snapshot from a snapshots array', () => {
    const green = snap({ key: 'g', color: 'green' })
    const red = snap({ key: 'r', color: 'red', status: { elapsed_minutes: 360, remaining_minutes: -120, target_minutes: 240, breached: true } })
    render(wrap(<SlaAgeIndicator snapshots={[green, red]} isLoading={false} isError={false} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'red')
  })

  it('shows fuller "left" text when not compact', () => {
    render(wrap(<SlaAgeIndicator snapshot={snap({ color: 'green' })} isLoading={false} isError={false} />))
    expect(screen.getByTestId('sla-age-indicator').textContent).toMatch(/left/i)
  })

  it('announces sr-only label for none state (no tier configured)', () => {
    render(wrap(<SlaAgeIndicator snapshot={null} isLoading={false} isError={false} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'none')
    expect(screen.getByText(/no sla tier configured/i)).toBeInTheDocument()
  })
})
