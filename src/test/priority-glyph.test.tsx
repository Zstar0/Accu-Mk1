import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('@/lib/api-priorities', () => ({
  getPriorities: vi.fn(async () => [
    {
      key: 'expedited',
      name: 'Expedited',
      rank: 20,
      icon: 'chevrons-up',
      color: 'red',
      pulse: true,
      is_default: false,
      is_active: true,
      sla_tier_id: null,
    },
    {
      key: 'high',
      name: 'High',
      rank: 10,
      icon: 'chevron-up',
      color: 'amber',
      pulse: false,
      is_default: false,
      is_active: true,
      sla_tier_id: null,
    },
    {
      key: 'default',
      name: 'Default',
      rank: 0,
      icon: 'minus',
      color: 'zinc',
      pulse: false,
      is_default: true,
      is_active: true,
      sla_tier_id: null,
    },
  ]),
}))
import { PriorityGlyph } from '@/components/common/PriorityGlyph'

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('PriorityGlyph', () => {
  it('renders nothing for the default priority', async () => {
    const { container } = wrap(
      <PriorityGlyph
        priority={{
          key: 'default',
          rank: 0,
          source_level: 'default',
          source_id: null,
        }}
      />
    )
    await new Promise(r => setTimeout(r, 0))
    expect(container.firstChild).toBeNull()
  })
  it('renders the icon with a source tooltip and pulses when configured', async () => {
    wrap(
      <PriorityGlyph
        priority={{
          key: 'expedited',
          rank: 20,
          source_level: 'customer',
          source_id: '777',
        }}
      />
    )
    const el = await screen.findByRole('img', {
      name: 'Expedited via customer (777)',
    })
    expect(el.className).toContain('animate-pulse')
    expect(el.querySelector('svg')).not.toBeNull()
  })
  it('card size is tinted and does not pulse for High', async () => {
    wrap(
      <PriorityGlyph
        priority={{
          key: 'high',
          rank: 10,
          source_level: 'order',
          source_id: '3291',
        }}
        size="card"
      />
    )
    const el = await screen.findByRole('img', { name: 'High via order 3291' })
    expect(el.className).toContain('bg-amber-500/10')
    expect(el.className).not.toContain('animate-pulse')
  })
})
