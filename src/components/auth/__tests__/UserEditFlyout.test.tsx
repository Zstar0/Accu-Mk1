import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import type { AuthUser } from '@/lib/auth-api'

const updateUser = vi.fn()
vi.mock('@/lib/auth-api', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/auth-api')>()),
  updateUser: (...args: unknown[]) => updateUser(...args),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const baseUser: AuthUser = {
  id: 7,
  email: 'jane@lab.com',
  role: 'standard',
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  senaite_configured: false,
  first_name: 'Jane',
  last_name: 'Doe',
}

async function renderFlyout(opts: { user?: Partial<AuthUser>; isSelf?: boolean } = {}) {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  const { UserEditFlyout } = await import('@/components/auth/UserEditFlyout')
  render(
    <UserEditFlyout
      user={{ ...baseUser, ...opts.user }}
      isSelf={opts.isSelf ?? false}
      onClose={onClose}
      onSaved={onSaved}
    />
  )
  return { onClose, onSaved }
}

describe('UserEditFlyout', () => {
  beforeEach(() => {
    updateUser.mockReset()
  })

  it('pre-fills the form from the user', async () => {
    await renderFlyout()
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Jane')
    expect((screen.getByLabelText('Last name') as HTMLInputElement).value).toBe('Doe')
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('jane@lab.com')
  })

  it('saves only changed fields and calls onSaved', async () => {
    updateUser.mockResolvedValue({ ...baseUser, first_name: 'Janet' })
    const { onSaved } = await renderFlyout()
    await userEvent.clear(screen.getByLabelText('First name'))
    await userEvent.type(screen.getByLabelText('First name'), 'Janet')
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }))
    expect(updateUser).toHaveBeenCalledWith(7, { first_name: 'Janet' })
    expect(onSaved).toHaveBeenCalled()
  })

  it('disables Save when email is invalid', async () => {
    await renderFlyout()
    await userEvent.clear(screen.getByLabelText('Email'))
    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email')
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled()
  })

  it('disables Role and Active when editing yourself', async () => {
    await renderFlyout({ isSelf: true })
    expect(screen.getByLabelText('Role')).toBeDisabled()
    expect(screen.getByLabelText('Active')).toBeDisabled()
  })

  it('keeps the flyout open (does not call onClose) when the save fails', async () => {
    updateUser.mockRejectedValue(new Error('Email already in use'))
    const { onClose } = await renderFlyout()
    await userEvent.clear(screen.getByLabelText('Email'))
    await userEvent.type(screen.getByLabelText('Email'), 'taken@lab.com')
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }))
    expect(updateUser).toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
