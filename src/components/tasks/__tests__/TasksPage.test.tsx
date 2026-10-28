import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { ColumnSizingState } from '@tanstack/react-table'
import { render, screen, act } from '@/test/test-utils'
import type { FlagResponse } from '@/lib/flags-api'
import type { TaskList } from '@/components/tasks/use-task-list'
import type { TasksPageSettings } from '@/components/tasks/tasks-page-settings'
import type { TasksTab } from '@/components/tasks/tasks-tabs'
import { TasksPage } from '@/components/tasks/TasksPage'

const m = vi.hoisted(() => ({
  ready: true,
  settings: null as unknown as TasksPageSettings,
  update: vi.fn(),
  list: null as unknown as TaskList,
  listTab: null as string | null,
  tableProps: null as Record<string, unknown> | null,
}))

vi.mock('@/components/tasks/tasks-page-settings', () => ({
  useTasksPageSettings: () => ({
    ready: m.ready,
    settings: m.settings,
    update: m.update,
  }),
}))
vi.mock('@/components/tasks/use-task-list', () => ({
  useTaskList: (tab: string) => {
    m.listTab = tab
    return m.list
  },
}))
vi.mock('@/components/tasks/TasksTable', () => ({
  TasksTable: (props: Record<string, unknown>) => {
    m.tableProps = props
    return <div data-testid="tasks-table" />
  },
}))
vi.mock('@/components/flags/FlagActivityFeed', () => ({
  FlagActivityFeed: ({ returnTo }: { returnTo?: string }) => (
    <div data-testid="activity-feed" data-return-to={String(returnTo)} />
  ),
}))
vi.mock('@/components/flags/RaiseFlagButton', () => ({
  RaiseFlagButton: ({ trigger }: { trigger?: ReactNode }) => <>{trigger}</>,
}))
vi.mock('@/components/flags/FlagsFilterBar', () => ({
  FlagsFilterBar: ({ showAssignee }: { showAssignee?: boolean }) => (
    <div data-testid="filter-bar" data-assignee={String(showAssignee)} />
  ),
}))

const FLAG = { id: 7, title: 'Re-prep vial' } as FlagResponse

function list(over: Partial<TaskList> = {}): TaskList {
  return {
    total: 1,
    visibleFlags: [FLAG],
    searchMeta: new Map(),
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    searchPending: false,
    unreadIds: new Set(),
    unreadCount: 0,
    buckets: {
      assigned: false,
      raised: false,
      watching: false,
      allOpen: false,
    },
    ...over,
  }
}

function setTab(tab: TasksTab) {
  m.settings = { ...m.settings, tab }
}

describe('TasksPage', () => {
  beforeEach(() => {
    localStorage.clear()
    m.ready = true
    m.settings = { v: 1, tab: 'assigned', sorting: [], columnSizing: {} }
    m.update = vi.fn()
    m.list = list()
    m.listTab = null
    m.tableProps = null
  })

  it('shows skeletons until settings are ready', () => {
    m.ready = false
    const { container } = render(<TasksPage />)
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3)
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.queryByTestId('tasks-table')).toBeNull()
    expect(m.listTab).toBeNull()
  })

  it('opens on the saved tab, Assigned to me by default', () => {
    const first = render(<TasksPage />)
    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Guide/ })).toHaveAttribute(
      'href',
      '/guides/flags-system-guide.html'
    )
    expect(screen.getByRole('button', { name: /New task/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Assigned to me' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(m.listTab).toBe('assigned')
    expect(screen.getByTestId('filter-bar')).toHaveAttribute(
      'data-assignee',
      'false'
    )
    expect(screen.getByText('1 of 1')).toBeInTheDocument()
    first.unmount()

    setTab('watching')
    render(<TasksPage />)
    expect(screen.getByRole('tab', { name: 'Watching' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(m.listTab).toBe('watching')
    expect(screen.getByTestId('filter-bar')).toHaveAttribute(
      'data-assignee',
      'true'
    )
  })

  // jsdom has no layout; the live check is a wide table at 1440 px.
  it('page width never grows with the table', () => {
    const { container } = render(<TasksPage />)
    expect(container.firstElementChild).toHaveClass('[contain:inline-size]')
  })

  it('switching tabs saves the tab', async () => {
    render(<TasksPage />)
    await userEvent.click(screen.getByRole('tab', { name: 'Raised by me' }))
    expect(m.update).toHaveBeenCalledWith({ tab: 'raised' })
  })

  it('Activity renders the feed and no table', () => {
    setTab('activity')
    render(<TasksPage />)
    // Threads opened from the feed return to this page.
    expect(screen.getByTestId('activity-feed')).toHaveAttribute(
      'data-return-to',
      'page'
    )
    expect(screen.queryByTestId('tasks-table')).toBeNull()
    expect(screen.queryByTestId('filter-bar')).toBeNull()
  })

  it('Unread hides the filter bar', () => {
    setTab('unread')
    m.list = list({ unreadCount: 1 })
    render(<TasksPage />)
    expect(screen.getByTestId('tasks-table')).toBeInTheDocument()
    expect(screen.queryByTestId('filter-bar')).toBeNull()
    expect(screen.getByRole('tab', { name: /Unread/ })).toHaveTextContent('1')
  })

  it('empty and filtered-out states use the agreed copy', async () => {
    const empty: [TasksTab, string][] = [
      ['assigned', 'Nothing assigned to you.'],
      ['raised', "You haven't raised any open tasks."],
      ['watching', "You're not watching any tasks."],
      ['all_open', 'No open tasks.'],
      ['unread', "You're all caught up."],
    ]
    for (const [tab, copy] of empty) {
      setTab(tab)
      m.list = list({ total: 0, visibleFlags: [] })
      const view = render(<TasksPage />)
      expect(screen.getByText(copy)).toBeInTheDocument()
      expect(screen.queryByTestId('tasks-table')).toBeNull()
      expect(screen.queryByTestId('filter-bar')).toBeNull()
      view.unmount()
    }

    setTab('assigned')
    m.list = list({ total: 3, visibleFlags: [] })
    const filtered = render(<TasksPage />)
    expect(
      screen.getByText('No tasks match these filters.')
    ).toBeInTheDocument()
    expect(screen.getByTestId('filter-bar')).toBeInTheDocument()
    filtered.unmount()

    const refetch = vi.fn()
    m.list = list({ total: 0, visibleFlags: [], isError: true, refetch })
    render(<TasksPage />)
    expect(screen.getByText("Couldn't load tasks.")).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalled()
  })

  it('a column resize commit saves the widths', () => {
    m.settings = { ...m.settings, columnSizing: { title: 360 } }
    render(<TasksPage />)
    const props = () =>
      m.tableProps as {
        columnSizing: ColumnSizingState
        onColumnSizingChange: (s: ColumnSizingState) => void
        onColumnSizingCommit: (s: ColumnSizingState) => void
      }
    expect(props().columnSizing).toEqual({ title: 360 })

    // A drag shows live widths without saving each step.
    act(() => props().onColumnSizingChange({ title: 420 }))
    expect(props().columnSizing).toEqual({ title: 420 })
    expect(m.update).not.toHaveBeenCalled()

    // Drag end saves once, then the table reads from settings again.
    act(() => props().onColumnSizingCommit({ title: 420 }))
    expect(m.update).toHaveBeenCalledTimes(1)
    expect(m.update).toHaveBeenCalledWith({ columnSizing: { title: 420 } })
    expect(props().columnSizing).toEqual({ title: 360 })

    // A click on a handle without dragging commits unchanged widths: no save.
    act(() => props().onColumnSizingCommit({ title: 360 }))
    expect(m.update).toHaveBeenCalledTimes(1)
  })
})
