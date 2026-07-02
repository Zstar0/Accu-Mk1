import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test/test-utils'
import { useAuthStore } from '@/store/auth-store'

const listUsers = vi.fn()
vi.mock('@/lib/auth-api', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/auth-api')>()),
  listUsers: () => listUsers(),
  updateUser: vi.fn().mockResolvedValue({}),
  resetUserPassword: vi.fn(),
  createUser: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const rows = [
  {
    id: 1,
    email: 'admin@lab.com',
    role: 'admin',
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    senaite_configured: false,
    first_name: 'Ada',
    last_name: 'Min',
  },
  {
    id: 2,
    email: 'jane@lab.com',
    role: 'standard',
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    senaite_configured: false,
    first_name: 'Jane',
    last_name: 'Doe',
  },
]

describe('UserManagement', () => {
  beforeEach(() => {
    listUsers.mockReset().mockResolvedValue(rows)
    useAuthStore.setState({ user: { ...rows[0] } as never })
  })

  it('opens the edit flyout when a user row is clicked', async () => {
    const { UserManagement } = await import('@/components/auth/UserManagement')
    render(<UserManagement />)
    await waitFor(() => expect(screen.getByText('jane@lab.com')).toBeInTheDocument())
    await userEvent.click(screen.getByText('jane@lab.com'))
    expect(screen.getByText('Edit user')).toBeInTheDocument()
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('jane@lab.com')
  })

  it('no longer shows the promote/demote toggle icons', async () => {
    const { UserManagement } = await import('@/components/auth/UserManagement')
    render(<UserManagement />)
    await waitFor(() => expect(screen.getByText('jane@lab.com')).toBeInTheDocument())
    expect(screen.queryByTitle('Promote to admin')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Deactivate')).not.toBeInTheDocument()
    // one reset-password action per row survives
    expect(screen.getAllByTitle('Reset password')).toHaveLength(rows.length)
  })
})
