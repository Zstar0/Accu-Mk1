import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@/test/test-utils'
import { useAuthStore } from '@/store/auth-store'
import type { WorkflowGraph } from '@/lib/workflow-api'
import { validateRequirements } from '@/components/preferences/panes/workflow/WorkflowDrawers'
import type { GraphCanvasProps } from '@/components/preferences/panes/workflow/GraphCanvas'

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

// Task 10: the canvas is React.lazy-loaded from the pane, and once it loads
// it's the ONLY view (the Task 9 list is Suspense-fallback-only, see
// WorkflowPane.tsx). Mock it so tests don't drive real @xyflow/react in
// jsdom (no ResizeObserver / layout) and can still exercise the click ->
// onSelectState/onSelectTransition -> sheet-open plumbing the real canvas
// wires up. Must use the '@/...' alias — a relative './workflow/GraphCanvas'
// path here resolves relative to THIS file (__tests__/), not to
// WorkflowPane.tsx's './workflow/GraphCanvas', so it wouldn't match.
vi.mock('@/components/preferences/panes/workflow/GraphCanvas', () => ({
  default: (props: GraphCanvasProps) => (
    <div
      data-testid="graph"
      data-nodes={props.graph.states.length}
      data-show-inactive={String(props.showInactive)}
    >
      {props.graph.states.map(s => (
        <button key={s.id} onClick={() => props.onSelectState(s.id)}>
          node-{s.slug}
        </button>
      ))}
      {props.graph.transitions.map(t => (
        <button key={t.id} onClick={() => props.onSelectTransition(t.id)}>
          edge-{t.verb}
        </button>
      ))}
    </div>
  ),
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
    {
      id: 11,
      from_state_id: 2,
      to_state_id: 1,
      verb: 'revert',
      label: 'Revert',
      description: null,
      // Pre-invalid from data (e.g. seeded before the client-side gate
      // existed): a non-manual kind with no value.
      requirements: [{ kind: 'field_present', value: null, note: null }],
      is_builtin: false,
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

  it('renders the lazy-loaded graph with the fetched states/transitions, and opens the state sheet with usage + not-yet-reachable badges on node click', async () => {
    await renderPane()

    const graph = await screen.findByTestId('graph')
    expect(graph).toHaveAttribute('data-nodes', '2')

    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'node-sample_due' }))
    let sheet = await screen.findByRole('dialog')
    expect(within(sheet).getByText(/5 in use/i)).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )

    await user.click(
      screen.getByRole('button', { name: 'node-orphan_state' })
    )
    sheet = await screen.findByRole('dialog')
    expect(
      within(sheet).getByText(/defined — not yet reachable/i)
    ).toBeInTheDocument()
  })

  it('toggles "show inactive" and passes it through to the canvas', async () => {
    await renderPane()
    const graph = await screen.findByTestId('graph')
    expect(graph).toHaveAttribute('data-show-inactive', 'false')

    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    await user.click(screen.getByRole('switch', { name: /show inactive/i }))

    expect(screen.getByTestId('graph')).toHaveAttribute(
      'data-show-inactive',
      'true'
    )
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

    await screen.findByTestId('graph')
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

    await screen.findByTestId('graph')
    await user.click(
      screen.getByRole('button', { name: 'node-orphan_state' })
    )
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
    await screen.findByTestId('graph')
    expect(
      screen.queryByRole('button', { name: /add state/i })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /add transition/i })
    ).not.toBeInTheDocument()
  })

  it('surfaces a toast and blocks the save when a requirement row is invalid (all-or-nothing)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    await renderPane()

    // 'Revert' ships pre-seeded with an invalid requirement (non-manual
    // kind, empty value) — no need to drive the Radix Select through
    // jsdom to reach the invalid state. Open it via the mocked canvas's
    // edge-click plumbing (edge id 11, verb 'revert').
    await screen.findByTestId('graph')
    await user.click(screen.getByRole('button', { name: 'edge-revert' }))
    const sheet = await screen.findByRole('dialog')
    await user.click(within(sheet).getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Requirement 1: 'field_present' needs a value"
      )
    )
    // Silent no-op regression guard: nothing in the batch saves, not even
    // the other (valid) rows.
    expect(updateWorkflowTransition).not.toHaveBeenCalled()
  })
})

describe('validateRequirements (pure)', () => {
  it('passes when every non-manual row has a value', () => {
    expect(
      validateRequirements([
        { kind: 'manual', value: null, note: null },
        { kind: 'field_present', value: 'client_sample_id', note: null },
      ])
    ).toEqual({ ok: true })
  })

  it('flags the first invalid row, 1-indexed, naming the offending kind', () => {
    expect(
      validateRequirements([
        { kind: 'manual', value: null, note: null },
        { kind: 'field_present', value: null, note: null },
        { kind: 'role_at_least', value: '', note: null },
      ])
    ).toEqual({
      ok: false,
      error: "Requirement 2: 'field_present' needs a value",
    })
  })
})
