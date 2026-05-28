import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SampleSlaIndicator } from '@/components/explorer/SampleSlaIndicator'

describe('SampleSlaIndicator', () => {
  it('renders empty span when snapshot is undefined', () => {
    render(<SampleSlaIndicator snapshot={undefined} />)
    expect(screen.queryByTestId('sample-sla-indicator')).toBeNull()
  })

  it('renders amber color from snapshot.color', () => {
    render(
      <SampleSlaIndicator
        snapshot={{
          color: 'amber',
          status: { target_minutes: 100, elapsed_minutes: 80, remaining_minutes: 20, breached: false },
          tier: {
            id: 1,
            name: 'Standard',
            target_minutes: 100,
            business_hours_only: false,
            is_default: true,
            amber_threshold_percent: 30,
            created_at: '2026-01-01T00:00:00',
            updated_at: '2026-01-01T00:00:00',
          },
          reason: { tierSource: 'default', unmappedKeywords: [] },
          priority: 'normal',
        }}
      />
    )
    const el = screen.getByTestId('sample-sla-indicator')
    expect(el.getAttribute('data-sla-color')).toBe('amber')
  })

  it('renders red text "over by" when status.breached', () => {
    render(
      <SampleSlaIndicator
        snapshot={{
          color: 'red',
          status: { target_minutes: 100, elapsed_minutes: 150, remaining_minutes: -50, breached: true },
          tier: {
            id: 1,
            name: 'Standard',
            target_minutes: 100,
            business_hours_only: false,
            is_default: true,
            amber_threshold_percent: 20,
            created_at: '2026-01-01T00:00:00',
            updated_at: '2026-01-01T00:00:00',
          },
          reason: { tierSource: 'default', unmappedKeywords: [] },
          priority: 'normal',
        }}
      />
    )
    const el = screen.getByTestId('sample-sla-indicator')
    expect(el.getAttribute('data-sla-color')).toBe('red')
    // i18n returns the key when no i18next instance — accept either "over" in the key or in translated text.
    expect(el.textContent ?? '').toMatch(/over|sla\.over/i)
  })
})
