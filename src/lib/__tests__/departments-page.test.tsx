import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '@/lib/api'
import { DepartmentsPage } from '@/components/hplc/DepartmentsPage'

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const DEPT_HPLC: api.Department = {
  id: 1,
  name: 'HPLC',
  sort_order: 1,
  color: 'blue',
  is_system: false,
  group_count: 2,
  service_count: 5,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
}

const DEPT_MICRO: api.Department = {
  id: 2,
  name: 'Microbiology',
  sort_order: 2,
  color: 'emerald',
  is_system: true,
  group_count: 1,
  service_count: 3,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
}

const NO_GROUPS: api.ServiceGroup[] = []

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DepartmentsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // 1. Renders a row per department from mocked getDepartments
  it('renders a row per department', async () => {
    vi.spyOn(api, 'getDepartments').mockResolvedValue([DEPT_HPLC, DEPT_MICRO])
    vi.spyOn(api, 'getServiceGroups').mockResolvedValue(NO_GROUPS)

    render(<DepartmentsPage />)

    expect(await screen.findByText('HPLC')).toBeInTheDocument()
    expect(screen.getByText('Microbiology')).toBeInTheDocument()
  })

  // 2. Typing in search narrows the visible rows by name
  it('search filters rows by name', async () => {
    vi.spyOn(api, 'getDepartments').mockResolvedValue([DEPT_HPLC, DEPT_MICRO])
    vi.spyOn(api, 'getServiceGroups').mockResolvedValue(NO_GROUPS)

    const user = userEvent.setup()
    render(<DepartmentsPage />)

    // Wait for rows to load
    await screen.findByText('HPLC')
    await screen.findByText('Microbiology')

    const searchBox = screen.getByPlaceholderText('Search departments...')
    await user.type(searchBox, 'hplc')

    // HPLC row stays visible
    expect(screen.getByText('HPLC')).toBeInTheDocument()
    // Microbiology is filtered out
    expect(screen.queryByText('Microbiology')).toBeNull()
  })

  // 3. Clicking "Add Department" shows flyout with empty Name and disabled Create
  //    button; typing a name enables the Create button
  it('Add Department shows empty form with Create disabled until name is typed', async () => {
    vi.spyOn(api, 'getDepartments').mockResolvedValue([DEPT_HPLC])
    vi.spyOn(api, 'getServiceGroups').mockResolvedValue(NO_GROUPS)

    const user = userEvent.setup()
    render(<DepartmentsPage />)

    // Wait for load to complete so we know the page is rendered
    await screen.findByText('HPLC')

    // Open the add flyout
    await user.click(screen.getByRole('button', { name: /add department/i }))

    // Name input should be empty
    const nameInput = screen.getByPlaceholderText('Department name')
    expect(nameInput).toHaveValue('')

    // Create button should be disabled when name is empty
    const createBtn = screen.getByRole('button', { name: /create/i })
    expect(createBtn).toBeDisabled()

    // Type a name — Create button should become enabled
    await user.type(nameInput, 'New Dept')
    expect(createBtn).not.toBeDisabled()
  })

  // 4. Clicking a row shows pre-filled edit flyout; Delete button hidden when is_system
  it('row click shows pre-filled edit flyout; Delete hidden for system departments', async () => {
    vi.spyOn(api, 'getDepartments').mockResolvedValue([DEPT_HPLC, DEPT_MICRO])
    vi.spyOn(api, 'getServiceGroups').mockResolvedValue(NO_GROUPS)

    const user = userEvent.setup()
    render(<DepartmentsPage />)

    await screen.findByText('HPLC')

    // Click HPLC row (not is_system) — flyout should show pre-filled name + Delete button
    await user.click(screen.getByText('HPLC'))
    const nameInput = screen.getByPlaceholderText('Department name')
    expect(nameInput).toHaveValue('HPLC')
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument()

    // Close the flyout, click Microbiology (is_system) — Delete should be absent
    await user.click(screen.getByRole('button', { name: /cancel/i }))

    // Wait for flyout to close
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Department name')).toBeNull()
    })

    await user.click(screen.getByText('Microbiology'))
    expect(screen.getByPlaceholderText('Department name')).toHaveValue('Microbiology')
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })
})
