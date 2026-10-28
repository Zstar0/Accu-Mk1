import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SortingState } from '@tanstack/react-table'
import { render, screen, fireEvent } from '@/test/test-utils'
import type { FlagResponse, EntityContext } from '@/lib/flags-api'
import { useUIStore } from '@/store/ui-store'
import { TasksTable } from '@/components/tasks/TasksTable'

// Keep the user directory off the network.
vi.mock('@/components/flags/flag-users', async orig => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    useFlagUsers: () => new Map(),
    nameForUser: (_m: unknown, id: number | null) =>
      id == null ? 'Unassigned' : `User ${id}`,
    initialsForUser: () => 'U',
  }
})

function flag(
  over: Partial<FlagResponse> & { entity?: EntityContext | null } = {}
): FlagResponse {
  return {
    id: 1,
    entity_type: 'sub_sample',
    entity_id: '90001',
    kind: 'issue',
    type: 'blocker',
    status: 'open',
    title: 'Needs re-prep',
    created_by: 1,
    assignee_id: 1,
    created_at: '2026-06-30T12:00:00',
    updated_at: '2026-06-30T12:00:00',
    resolved_at: null,
    resolved_by: null,
    due_at: null,
    ...over,
  }
}

function renderTable(flags: FlagResponse[], sorting: SortingState = []) {
  const onSortingChange = vi.fn()
  const table = (s: SortingState) => (
    <TasksTable
      flags={flags}
      unreadIds={new Set()}
      searchMeta={new Map()}
      sorting={s}
      onSortingChange={onSortingChange}
      columnSizing={{}}
      onColumnSizingChange={vi.fn()}
      onColumnSizingCommit={vi.fn()}
    />
  )
  const view = render(table(sorting))
  return {
    ...view,
    onSortingChange,
    sortBy: (s: SortingState) => view.rerender(table(s)),
  }
}

/** Body rows' titles, top to bottom (cells: accent, Item, Type, Title, ...). */
const titles = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map(r => r.querySelectorAll('td')[3]?.textContent)

describe('TasksTable', () => {
  beforeEach(() => {
    useUIStore.setState({
      flagsThreadId: null,
      flagsThreadReturnTo: null,
      flagsFlyoutOpen: false,
    })
  })

  it('renders every header label', () => {
    renderTable([flag()])
    for (const label of [
      'Item',
      'Type',
      'Title',
      'Assignee',
      'Status',
      'Due',
      'Last activity',
      'Created',
    ]) {
      expect(
        screen.getByRole('columnheader', { name: label })
      ).toBeInTheDocument()
    }
  })

  it('clicking Due reports an ascending sort', () => {
    const { onSortingChange } = renderTable([flag()])
    fireEvent.click(screen.getByRole('button', { name: 'Due' }))
    expect(onSortingChange).toHaveBeenCalledWith([{ id: 'due', desc: false }])
  })

  it('due sort keeps tasks with no due date last both ways', () => {
    const flags = [
      flag({ id: 1, title: 'No due' }),
      flag({ id: 2, title: 'Late', due_at: '2026-07-10T12:00:00' }),
      flag({ id: 3, title: 'Early', due_at: '2026-07-01T12:00:00' }),
    ]
    const { sortBy, container } = renderTable(flags, [
      { id: 'due', desc: false },
    ])
    expect(titles()).toEqual(['Early', 'Late', 'No due'])
    // The blank cell is empty on this page, not a dash.
    expect(container.textContent).not.toContain('—')

    sortBy([{ id: 'due', desc: true }])
    expect(titles()).toEqual(['Late', 'Early', 'No due'])
  })

  it('assignee sort puts Unassigned last both ways', () => {
    const flags = [
      flag({ id: 1, title: 'Nobody', assignee_id: null }),
      flag({ id: 2, title: 'Second', assignee_id: 2 }),
      flag({ id: 3, title: 'First', assignee_id: 1 }),
    ]
    const { sortBy } = renderTable(flags, [{ id: 'assignee', desc: false }])
    expect(titles()).toEqual(['First', 'Second', 'Nobody'])

    sortBy([{ id: 'assignee', desc: true }])
    expect(titles()).toEqual(['Second', 'First', 'Nobody'])
  })

  it('status sorts by workflow order, not alphabet', () => {
    const flags = [
      flag({ id: 1, title: 'c', status: 'closed' }),
      flag({ id: 2, title: 'b', status: 'blocked' }),
      flag({ id: 3, title: 'r', status: 'resolved' }),
      flag({ id: 4, title: 'o', status: 'open' }),
      flag({ id: 5, title: 'i', status: 'in_progress' }),
    ]
    renderTable(flags, [{ id: 'status', desc: false }])
    expect(titles()).toEqual(['o', 'i', 'b', 'r', 'c'])
  })

  it('general tasks sort under Item without crashing', () => {
    const flags = [
      flag({ id: 1, title: 'Vial', entity_type: 'sub_sample' }),
      flag({
        id: 2,
        title: 'General',
        entity_type: 'general_task',
        entity_id: null,
      }),
      flag({ id: 3, title: 'Legacy', entity_type: null, entity_id: null }),
    ]
    renderTable(flags, [{ id: 'item', desc: false }])
    // Both general labels sort ahead of the vial; equal keys keep input order.
    expect(titles()).toEqual(['General', 'Legacy', 'Vial'])
  })

  it('a row click opens the thread with the page marker', () => {
    renderTable([flag({ id: 1 })])
    fireEvent.click(screen.getByText('Needs re-prep'))
    expect(useUIStore.getState()).toMatchObject({
      flagsThreadId: 1,
      flagsThreadReturnTo: 'page',
    })
  })

  it('Enter on a focused row opens the thread with the page marker', () => {
    renderTable([flag({ id: 4 })])
    const row = screen.getAllByRole('row')[1]
    if (!row) throw new Error('no body row')
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(useUIStore.getState()).toMatchObject({
      flagsThreadId: 4,
      flagsThreadReturnTo: 'page',
    })
  })

  it('the Item deep-link button does not open the thread', () => {
    const navigateToSample = vi.fn()
    useUIStore.setState({ navigateToSample })
    renderTable([
      flag({
        id: 9,
        entity: {
          entity_type: 'sub_sample',
          entity_id: '90001',
          label: 'Vial 90001',
          sample_id: 'P-0071',
          analyses: ['PEPT-Total'],
          lot: null,
          deep_link: { kind: 'sample', id: 'P-0071' },
        },
      }),
    ])
    fireEvent.click(screen.getByRole('button', { name: /Vial 90001/ }))
    expect(navigateToSample).toHaveBeenCalledWith('P-0071')
    expect(useUIStore.getState().flagsThreadId).toBeNull()
  })
})
