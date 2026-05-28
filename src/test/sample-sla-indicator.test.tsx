import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SampleSlaIndicator } from '@/components/explorer/SampleSlaIndicator'
import type { SampleSlaSnapshot } from '@/services/order-sla'

const tier = (
  id: number,
  name: string,
  target_minutes: number,
  amber = 20
) => ({
  id,
  name,
  target_minutes,
  business_hours_only: false,
  is_default: id === 1,
  amber_threshold_percent: amber,
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-01-01T00:00:00',
})

const snap = (
  overrides: Partial<SampleSlaSnapshot> = {}
): SampleSlaSnapshot => ({
  groupKey: 'no-group',
  color: 'amber',
  status: { target_minutes: 100, elapsed_minutes: 80, remaining_minutes: 20, breached: false },
  tier: tier(1, 'Standard', 100, 30),
  reason: { tierSource: 'default', unmappedKeywords: [] },
  priority: 'normal',
  ...overrides,
})

describe('SampleSlaIndicator', () => {
  it('renders empty span when snapshots is undefined', () => {
    render(<SampleSlaIndicator snapshots={undefined} />)
    expect(screen.queryByTestId('sample-sla-indicator')).toBeNull()
  })

  it('renders empty span when snapshots is empty array', () => {
    render(<SampleSlaIndicator snapshots={[]} />)
    expect(screen.queryByTestId('sample-sla-indicator')).toBeNull()
  })

  it('renders amber color from a single snapshot.color', () => {
    render(<SampleSlaIndicator snapshots={[snap({ color: 'amber' })]} />)
    const el = screen.getByTestId('sample-sla-indicator')
    expect(el.getAttribute('data-sla-color')).toBe('amber')
  })

  it('renders red text "over by" when single snapshot status.breached', () => {
    render(
      <SampleSlaIndicator
        snapshots={[
          snap({
            color: 'red',
            status: { target_minutes: 100, elapsed_minutes: 150, remaining_minutes: -50, breached: true },
          }),
        ]}
      />
    )
    const el = screen.getByTestId('sample-sla-indicator')
    expect(el.getAttribute('data-sla-color')).toBe('red')
    // i18n returns the key when no i18next instance — accept either "over" in the key or in translated text.
    expect(el.textContent ?? '').toMatch(/over|sla\.over/i)
  })

  it('single snapshot does NOT render the group label (preserves compact layout)', () => {
    render(
      <SampleSlaIndicator
        snapshots={[snap({ groupKey: 10, groupName: 'HPLC', color: 'green' })]}
      />
    )
    const el = screen.getByTestId('sample-sla-indicator')
    // No prefix label for single-tier samples.
    expect(el.textContent ?? '').not.toContain('HPLC')
  })

  it('renders multiple snapshots stacked, worst-color first, each labeled with group name', () => {
    render(
      <SampleSlaIndicator
        snapshots={[
          // Intentionally pass green first — the indicator should sort red to the top.
          snap({
            groupKey: 11,
            groupName: 'Sterility',
            color: 'green',
            status: { target_minutes: 10080, elapsed_minutes: 100, remaining_minutes: 9980, breached: false },
            tier: tier(3, 'Sterility', 10080),
          }),
          snap({
            groupKey: 10,
            groupName: 'HPLC',
            color: 'red',
            status: { target_minutes: 1440, elapsed_minutes: 2880, remaining_minutes: -1440, breached: true },
            tier: tier(2, 'HPLC', 1440),
          }),
        ]}
      />
    )
    expect(screen.getByTestId('sample-sla-indicator-list')).toBeInTheDocument()
    const indicators = screen.getAllByTestId('sample-sla-indicator')
    expect(indicators).toHaveLength(2)
    // Red comes first (worst color).
    expect(indicators[0]?.getAttribute('data-sla-color')).toBe('red')
    expect(indicators[0]?.getAttribute('data-group-key')).toBe('10')
    expect(indicators[0]?.textContent ?? '').toContain('HPLC')
    // Green second.
    expect(indicators[1]?.getAttribute('data-sla-color')).toBe('green')
    expect(indicators[1]?.getAttribute('data-group-key')).toBe('11')
    expect(indicators[1]?.textContent ?? '').toContain('Sterility')
  })

  it('ties between same-color rows are broken alphabetically by group name', () => {
    render(
      <SampleSlaIndicator
        snapshots={[
          snap({ groupKey: 20, groupName: 'Zeta', color: 'amber' }),
          snap({ groupKey: 21, groupName: 'Alpha', color: 'amber' }),
        ]}
      />
    )
    const indicators = screen.getAllByTestId('sample-sla-indicator')
    expect(indicators[0]?.textContent ?? '').toContain('Alpha')
    expect(indicators[1]?.textContent ?? '').toContain('Zeta')
  })

  it('multi-snapshot row with NO_GROUP_KEY renders without a label (no real group name to show)', () => {
    render(
      <SampleSlaIndicator
        snapshots={[
          snap({ groupKey: 10, groupName: 'HPLC', color: 'red',
            status: { target_minutes: 1440, elapsed_minutes: 2880, remaining_minutes: -1440, breached: true } }),
          snap({ groupKey: 'no-group', groupName: undefined, color: 'green' }),
        ]}
      />
    )
    const indicators = screen.getAllByTestId('sample-sla-indicator')
    const noGroupRow = indicators.find(el => el.getAttribute('data-group-key') === 'no-group')
    expect(noGroupRow).toBeDefined()
    // No group name prefix for the NO_GROUP_KEY row — text is just the status text.
    expect(noGroupRow?.querySelector('.text-muted-foreground\\/60')).toBeNull()
  })
})
