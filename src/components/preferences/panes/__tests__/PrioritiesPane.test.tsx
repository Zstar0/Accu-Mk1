import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type * as ApiModule from '@/lib/api'
// Real i18n resources so the pane's t() calls resolve to English copy instead
// of echoing raw keys back into the DOM.
import '@/i18n/config'

const prios = [
  {
    key: 'expedited',
    name: 'Expedited',
    rank: 20,
    icon: 'chevrons-up',
    color: 'red',
    pulse: true,
    is_default: false,
    is_active: true,
    sla_tier_id: 2,
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
]
vi.mock('@/lib/api-priorities', () => ({
  getPriorities: vi.fn(async () => prios),
  patchPriority: vi.fn(async (key: string, body: object) => ({
    ...prios.find(p => p.key === key),
    ...body,
  })),
  createPriority: vi.fn(),
  deactivatePriority: vi.fn(),
  setDefaultPriority: vi.fn(),
  getCustomerPriorities: vi.fn(async () => []),
  getCustomersSeen: vi.fn(async () => []),
  assignPriority: vi.fn(),
  assignPriorityBulk: vi.fn(),
  resolvePriorities: vi.fn(),
}))
vi.mock('@/lib/api', async orig => ({
  ...(await orig<typeof ApiModule>()),
  getSlaTiers: vi.fn(async () => [
    {
      id: 1,
      name: 'Standard',
      target_minutes: 2880,
      is_default: true,
      business_hours_only: true,
      amber_threshold_percent: 20,
    },
    {
      id: 2,
      name: 'Fast',
      target_minutes: 480,
      is_default: false,
      business_hours_only: false,
      amber_threshold_percent: 20,
    },
  ]),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (sel: (s: { user: { role: string } }) => unknown) =>
    sel({ user: { role: 'admin' } }),
}))
import { patchPriority } from '@/lib/api-priorities'
import { PrioritiesPane } from '@/components/preferences/panes/PrioritiesPane'

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('PrioritiesPane', () => {
  it('lists priorities by rank with their SLA tier and toggles pulse through PATCH', async () => {
    wrap(<PrioritiesPane />)
    const rows = await screen.findAllByTestId('priority-row')
    expect(rows[0]).toHaveTextContent('Expedited')
    expect(rows[0]).toHaveTextContent('Fast')
    fireEvent.click(screen.getByRole('switch', { name: 'Pulse Expedited' }))
    await waitFor(() =>
      expect(patchPriority).toHaveBeenCalledWith('expedited', { pulse: false })
    )
  })

  it('renders translated copy, not raw i18n keys', async () => {
    wrap(<PrioritiesPane />)
    await screen.findAllByTestId('priority-row')
    // Section headings + the customer block resolve through locales/en.json.
    expect(
      screen.getAllByRole('heading', { name: 'Priorities' }).length
    ).toBeGreaterThan(0)
    expect(screen.getByText('Customer priorities')).toBeInTheDocument()
    expect(screen.getAllByText('Pulse').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain(
      'preferences.prioritiesPane'
    )
  })
})
