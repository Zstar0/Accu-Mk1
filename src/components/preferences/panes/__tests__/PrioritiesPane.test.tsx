import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type * as ApiModule from '@/lib/api'
import type {
  CustomerPriority,
  CustomerSeen,
  Priority,
} from '@/lib/api-priorities'
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
  createPriority: vi.fn(async (body: object) => ({ key: 'new', ...body })),
  deactivatePriority: vi.fn(),
  setDefaultPriority: vi.fn(),
  getCustomerPriorities: vi.fn(async () => []),
  getCustomersSeen: vi.fn(async () => []),
  assignPriority: vi.fn(async () => ({
    level: 'customer',
    id: '1',
    old_key: null,
    new_key: null,
    affected_sample_pks: [],
  })),
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
import {
  assignPriority,
  createPriority,
  getCustomerPriorities,
  getCustomersSeen,
  getPriorities,
  patchPriority,
} from '@/lib/api-priorities'
import { PrioritiesPane } from '@/components/preferences/panes/PrioritiesPane'

// `clearAllMocks` (not `resetAllMocks`) — resetting would wipe the async
// factories above and every test would then see an undefined catalog.
beforeEach(() => vi.clearAllMocks())

// Typed row builder for per-test catalogs, so overrides stay Priority-shaped.
const prio = (
  over: Partial<Priority> & { key: string; name: string }
): Priority => ({
  rank: 0,
  icon: 'minus',
  color: 'zinc',
  pulse: false,
  is_default: false,
  is_active: true,
  sla_tier_id: null,
  ...over,
})

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
    // Section headings, the customer block and the table headers all resolve
    // through locales/en.json.
    expect(
      screen.getAllByRole('heading', { name: 'Priorities' }).length
    ).toBeGreaterThan(0)
    expect(screen.getByText('Customer priorities')).toBeInTheDocument()
    expect(screen.getAllByText('Pulse').length).toBeGreaterThan(0)
    // The customer table has its own query gate, so wait for it to land.
    expect(
      await screen.findByRole('columnheader', { name: 'Customer' })
    ).toBeVisible()
    expect(screen.getByRole('columnheader', { name: 'Note' })).toBeVisible()
  })

  it('shows a spinner while the catalog loads and an error line when it fails', async () => {
    vi.mocked(getPriorities).mockRejectedValueOnce(new Error('boom'))
    wrap(<PrioritiesPane />)
    expect(screen.getByTestId('pane-spinner')).toBeInTheDocument()
    expect(screen.queryByTestId('priority-row')).toBeNull()
    expect(
      await screen.findByText('Failed to load priorities.')
    ).toBeInTheDocument()
    // A failed catalog must not render an empty table beside a live Add form.
    expect(screen.queryByPlaceholderText('New priority name')).toBeNull()
  })

  it('moves the lowest row up by swapping the two ranks', async () => {
    wrap(<PrioritiesPane />)
    await screen.findAllByTestId('priority-row')
    fireEvent.click(screen.getByRole('button', { name: 'Move up Default' }))
    await waitFor(() =>
      expect(vi.mocked(patchPriority).mock.calls.length).toBe(2)
    )
    expect(patchPriority).toHaveBeenCalledWith('default', { rank: 20 })
    expect(patchPriority).toHaveBeenCalledWith('expedited', { rank: 0 })
  })

  it('nudges past a neighbour of equal rank instead of swapping a no-op', async () => {
    vi.mocked(getPriorities).mockResolvedValueOnce([
      prio({ key: 'alpha', name: 'Alpha', rank: 10 }),
      prio({ key: 'beta', name: 'Beta', rank: 10 }),
    ])
    wrap(<PrioritiesPane />)
    await screen.findAllByTestId('priority-row')
    // Equal ranks tie-break by name, so Beta sits below Alpha.
    fireEvent.click(screen.getByRole('button', { name: 'Move up Beta' }))
    await waitFor(() =>
      expect(patchPriority).toHaveBeenCalledWith('beta', { rank: 11 })
    )
    expect(vi.mocked(patchPriority).mock.calls.length).toBe(1)
  })

  it('creates a priority above the top rank from the add form', async () => {
    wrap(<PrioritiesPane />)
    await screen.findAllByTestId('priority-row')
    fireEvent.change(screen.getByPlaceholderText('New priority name'), {
      target: { value: '  Rush  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(createPriority).toHaveBeenCalled())
    // react-query hands the mutationFn a second (context) argument, so assert
    // on the payload rather than the whole call signature.
    expect(vi.mocked(createPriority).mock.calls[0]?.[0]).toEqual({
      name: 'Rush',
      rank: 30,
      icon: 'chevron-up',
      color: 'amber',
      pulse: false,
    })
  })

  it('does not PATCH when a rename blur leaves the name unchanged or empty', async () => {
    wrap(<PrioritiesPane />)
    await screen.findAllByTestId('priority-row')
    const input = screen.getByRole('textbox', { name: 'Name Expedited' })
    fireEvent.blur(input)
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(patchPriority).not.toHaveBeenCalled()
    // The emptied field falls back to the row's real name.
    expect(input).toHaveValue('Expedited')
  })

  it('restores the name field when the server rejects a rename', async () => {
    vi.mocked(patchPriority).mockRejectedValueOnce(new Error('nope'))
    wrap(<PrioritiesPane />)
    await screen.findAllByTestId('priority-row')
    const input = screen.getByRole('textbox', { name: 'Name Expedited' })
    fireEvent.change(input, { target: { value: 'Rushed' } })
    fireEvent.blur(input)
    await waitFor(() =>
      expect(patchPriority).toHaveBeenCalledWith('expedited', {
        name: 'Rushed',
      })
    )
    // The catalog (and so the remount key) never changed, so the row would
    // otherwise keep showing the name the server refused.
    await waitFor(() => expect(input).toHaveValue('Expedited'))
  })
})

describe('PrioritiesPane — customer priorities', () => {
  const row: CustomerPriority = {
    wp_customer_user_id: 7,
    priority_key: 'expedited',
    note: 'Key account',
    updated_at: null,
    customer_name: 'Acme Labs',
    customer_email: 'ops@acme.test',
  }

  it('lists assigned customers and clears one', async () => {
    vi.mocked(getCustomerPriorities).mockResolvedValueOnce([row])
    wrap(<PrioritiesPane />)
    expect(await screen.findByText('Acme Labs')).toBeInTheDocument()
    expect(screen.getByText('Key account')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() =>
      expect(assignPriority).toHaveBeenCalledWith({
        level: 'customer',
        id: '7',
        priority_key: null,
      })
    )
  })

  it('searches customers and assigns a priority to one', async () => {
    const seen: CustomerSeen = {
      wp_customer_user_id: 9,
      customer_name: 'Beta Clinic',
      customer_email: 'lab@beta.test',
      last_order_at: null,
    }
    vi.mocked(getCustomersSeen).mockResolvedValueOnce([seen])
    wrap(<PrioritiesPane />)
    await screen.findAllByTestId('priority-row')
    fireEvent.change(
      screen.getByPlaceholderText('Search customers seen on orders'),
      { target: { value: 'beta' } }
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Search customers seen on orders' })
    )
    expect(await screen.findByText('Beta Clinic')).toBeInTheDocument()
    expect(getCustomersSeen).toHaveBeenCalledWith('beta')
    fireEvent.click(
      screen.getByRole('combobox', { name: 'Set priority for lab@beta.test' })
    )
    fireEvent.click(await screen.findByRole('option', { name: 'Expedited' }))
    await waitFor(() =>
      expect(assignPriority).toHaveBeenCalledWith({
        level: 'customer',
        id: '9',
        priority_key: 'expedited',
      })
    )
  })
})
