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
import { legacyEffectivePriority } from '@/lib/inbox-sla'

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('PriorityGlyph', () => {
  it('preview mode renders the default priority glyph for the editor', async () => {
    wrap(
      <PriorityGlyph
        priority={{
          key: 'default',
          rank: 0,
          source_level: 'default',
          source_id: null,
        }}
        size="card"
        preview
      />
    )
    expect(
      await screen.findByRole('img', { name: 'Default' })
    ).toBeInTheDocument()
  })
  it('renders nothing for the default priority', async () => {
    wrap(
      <>
        <div data-testid="default-slot">
          <PriorityGlyph
            priority={{
              key: 'default',
              rank: 0,
              source_level: 'default',
              source_id: null,
            }}
          />
        </div>
        <div data-testid="high-slot">
          <PriorityGlyph
            priority={{
              key: 'high',
              rank: 10,
              source_level: 'order',
              source_id: '3291',
            }}
          />
        </div>
      </>
    )
    // The sibling glyph resolving proves the priority list has loaded, so the
    // default glyph rendering nothing is the is_default branch, not the
    // not-yet-loaded branch.
    await screen.findByRole('img', { name: /High/ })
    expect(screen.queryByRole('img', { name: /^Default/ })).toBeNull()
    expect(screen.getByTestId('default-slot').childNodes.length).toBe(0)
    expect(screen.getByTestId('high-slot').childNodes.length).toBe(1)
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
    expect(el.className).toContain('motion-safe:animate-pulse')
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
  it('sample-level priority reads "via sample" and header size uses the w-7 box', async () => {
    wrap(
      <PriorityGlyph
        priority={{
          key: 'high',
          rank: 10,
          source_level: 'sample',
          source_id: null,
        }}
        size="header"
      />
    )
    const el = await screen.findByRole('img', { name: 'High via sample' })
    expect(el.className).toContain('w-7')
  })
  it('a legacy-wire glyph reads the bare name, inventing no provenance', async () => {
    // legacyEffectivePriority stamps source_level 'unknown': the legacy
    // priority STRING carried a name and no level, so "via sample" would be a
    // claim the wire never made.
    const p = legacyEffectivePriority('high')
    expect(p.source_level).toBe('unknown')
    wrap(<PriorityGlyph priority={p} size="card" />)
    expect(await screen.findByRole('img', { name: 'High' })).toBeVisible()
  })
})
