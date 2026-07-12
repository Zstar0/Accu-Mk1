import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@/test/test-utils'
import { useAuthStore } from '@/store/auth-store'
import type { WorkflowGraph } from '@/lib/workflow-api'

// Mirrors FlagsPane.recurring.test.tsx: mock the api layer (importActual
// spread so the pane's type-only imports still resolve), keep the real
// component + real auth store.
const getWorkflowGraph = vi.fn()
const createWorkflowState = vi.fn()
const updateWorkflowState = vi.fn()
const deleteWorkflowState = vi.fn()
const createWorkflowTransition = vi.fn()
const updateWorkflowTransition = vi.fn()
const deleteWorkflowTransition = vi.fn()

vi.mock('@/lib/workflow-api', async () => {
  const actual = (await vi.importActual('@/lib/workflow-api')) as Record<
    string,
    unknown
  >
  return {
    ...actual,
    getWorkflowGraph: (...args: unknown[]) => getWorkflowGraph(...args),
    createWorkflowState: (...args: unknown[]) => createWorkflowState(...args),
    updateWorkflowState: (...args: unknown[]) => updateWorkflowState(...args),
    deleteWorkflowState: (...args: unknown[]) => deleteWorkflowState(...args),
    createWorkflowTransition: (...args: unknown[]) =>
      createWorkflowTransition(...args),
    updateWorkflowTransition: (...args: unknown[]) =>
      updateWorkflowTransition(...args),
    deleteWorkflowTransition: (...args: unknown[]) =>
      deleteWorkflowTransition(...args),
  }
})

const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

const SAMPLE_GRAPH: WorkflowGraph = {
  scope: 'sample',
  states: [
    {
      id: 1,
      slug: 'sample_due',
      label: 'Sample Due',
      description: null,
      category: 'active',
      color: '#3b82f6',
      sort_order: 0,
      is_builtin: true,
      is_active: true,
      usage_count: 5,
    },
    {
      id: 2,
      slug: 'orphan_state',
      label: 'Orphan State',
      description: null,
      category: 'active',
      color: null,
      sort_order: 1,
      is_builtin: false,
      is_active: true,
      usage_count: 0,
    },
  ],
  transitions: [
    {
      id: 10,
      from_state_id: 1,
      to_state_id: 2,
      verb: 'advance',
      label: 'Advance',
      description: null,
      requirements: [],
      is_builtin: true,
      is_active: true,
    },
  ],
}

async function renderPane() {
  const { WorkflowPane } =
    await import('@/components/preferences/panes/WorkflowPane')
  return render(<WorkflowPane />)
}

describe('WorkflowPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getWorkflowGraph.mockResolvedValue(SAMPLE_GRAPH)
    useAuthStore.setState({ user: { id: 1, role: 'admin' } as never })
  })

  it('renders both scope tabs and the persistent SENAITE banner', async () => {
    await renderPane()
    expect(
      await screen.findByRole('tab', { name: /sample/i })
    ).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /analysis/i })).toBeInTheDocument()
    expect(
      screen.getByText(
        /Descriptive while SENAITE is system of record — requirements are documentation until the authority swap\./i
      )
    ).toBeInTheDocument()
  })

  it('shows the states list with seeded labels, usage badges, and the not-yet-reachable badge', async () => {
    await renderPane()
    expect(await screen.findByText('Sample Due')).toBeInTheDocument()
    expect(screen.getByText('Orphan State')).toBeInTheDocument()
    expect(screen.getByText(/5 in use/i)).toBeInTheDocument()
    expect(screen.getByText(/defined — not yet reachable/i)).toBeInTheDocument()
  })

  it('submits the create-state dialog, calls createWorkflowState, and invalidates the graph query', async () => {
    createWorkflowState.mockResolvedValue({
      id: 3,
      slug: 'new_state',
      label: 'New State',
      description: null,
      category: 'active',
      color: null,
      sort_order: 2,
      is_builtin: false,
      is_active: true,
      usage_count: 0,
    })
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    await renderPane()

    await screen.findByText('Sample Due')
    await user.click(screen.getByRole('button', { name: /add state/i }))

    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/slug/i), 'new_state')
    await user.type(within(dialog).getByLabelText(/^label$/i), 'New State')
    await user.click(within(dialog).getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(createWorkflowState).toHaveBeenCalled())
    expect(createWorkflowState.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        entity_scope: 'sample',
        slug: 'new_state',
        label: 'New State',
      })
    )
    // onSuccess invalidates ['workflow-graph', scope] -> the query refetches,
    // so getWorkflowGraph is called a second time.
    await waitFor(() => expect(getWorkflowGraph).toHaveBeenCalledTimes(2))
  })

  it('shows the backend 409 detail in a toast when a delete is blocked', async () => {
    deleteWorkflowState.mockRejectedValue(
      new Error("state 'orphan_state' has 3 live row(s) — deactivate instead")
    )
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    await renderPane()

    await user.click(await screen.findByText('Orphan State'))
    const sheet = await screen.findByRole('dialog')
    await user.click(within(sheet).getByRole('button', { name: /delete/i }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining('has 3 live row(s)')
      )
    )
  })

  it('hides Add controls for a non-admin (read-only view)', async () => {
    useAuthStore.setState({ user: { id: 2, role: 'standard' } as never })
    await renderPane()
    await screen.findByText('Sample Due')
    expect(
      screen.queryByRole('button', { name: /add state/i })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /add transition/i })
    ).not.toBeInTheDocument()
  })
})
