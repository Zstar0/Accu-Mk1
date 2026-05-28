import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OrderSlaCell } from '@/components/explorer/OrderSlaCell'
import type { SlaTier } from '@/lib/api'

const tier = (target_minutes: number, amber = 20): SlaTier => ({
  id: 1,
  name: 'Standard',
  target_minutes,
  business_hours_only: false,
  is_default: true,
  amber_threshold_percent: amber,
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-01-01T00:00:00',
})

describe('OrderSlaCell — 7 states', () => {
  it('renders loading state when isLoading', () => {
    render(<OrderSlaCell verdict={{ color: 'awaiting' }} isLoading />)
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('loading')
  })

  it('renders awaiting when no received samples', () => {
    render(<OrderSlaCell verdict={{ color: 'awaiting' }} />)
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('awaiting')
    expect(cell.textContent).toContain('—')
  })

  it('renders met when all samples published', () => {
    render(<OrderSlaCell verdict={{ color: 'met' }} />)
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('met')
    expect(cell.textContent).toContain('✓')
  })

  it('renders green', () => {
    render(
      <OrderSlaCell
        verdict={{
          color: 'green',
          drivingSampleId: 'PB-001',
          drivingTier: tier(100),
          drivingStatus: {
            target_minutes: 100,
            elapsed_minutes: 10,
            remaining_minutes: 90,
            breached: false,
          },
        }}
      />
    )
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('green')
  })

  it('renders amber', () => {
    render(
      <OrderSlaCell
        verdict={{
          color: 'amber',
          drivingSampleId: 'PB-002',
          drivingTier: tier(100, 30),
          drivingStatus: {
            target_minutes: 100,
            elapsed_minutes: 80,
            remaining_minutes: 20,
            breached: false,
          },
        }}
      />
    )
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('amber')
  })

  it('renders red (breached)', () => {
    render(
      <OrderSlaCell
        verdict={{
          color: 'red',
          drivingSampleId: 'PB-003',
          drivingTier: tier(100),
          drivingStatus: {
            target_minutes: 100,
            elapsed_minutes: 150,
            remaining_minutes: -50,
            breached: true,
          },
        }}
      />
    )
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('red')
  })

  it('renders error/unavailable when isError', () => {
    render(<OrderSlaCell verdict={{ color: 'awaiting' }} isError />)
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('error')
  })

  it('isError takes priority over isLoading', () => {
    render(<OrderSlaCell verdict={{ color: 'awaiting' }} isLoading isError />)
    const cell = screen.getByTestId('order-sla-cell')
    expect(cell.getAttribute('data-sla-color')).toBe('error')
  })
})
