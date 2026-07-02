# Admin Edit-User Flyout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin edit-user flyout to the User Management page — click a user row to open a right-side slide-out (mirroring the Instruments page) and edit first name, last name, email, role, and active status.

**Architecture:** Frontend-only. A new presentational `UserEditFlyout` component reproduces the Instruments slide-out shell and holds a `useState` form wired to the existing `updateUser()` API call. `UserManagement` tracks a `selectedUserId`, makes rows clickable, and renders the flyout; the two redundant role/active toggle icons move into the flyout.

**Tech Stack:** React + TypeScript, shadcn/ui (`Input`/`Label`/`Select`/`Switch`/`Button`), sonner toast, Vitest + Testing Library. **npm only.**

## Global Constraints

- **Additive, frontend-only.** No backend, API-layer, or migration changes. `PUT /auth/users/{id}` and `updateUser()`/`UserUpdateInput` already accept `first_name`, `last_name`, `email`, `role`, `is_active`.
- **No react-hook-form** — the repo doesn't use it; forms are plain `useState`.
- **Self-edit guard:** when the edited user is the current user, Role and Active are disabled (prevents self-lockout); name/email stay editable.
- Follow the existing test idiom: `render`/`screen` from `@/test/test-utils`, `userEvent`, `vi.mock` the api module, dynamic `import()` of the component under test.

---

### Task 1: `UserEditFlyout` component

**Files:**
- Create: `C:\tmp\flag-ui\src\components\auth\UserEditFlyout.tsx`
- Test: `C:\tmp\flag-ui\src\components\auth\__tests__\UserEditFlyout.test.tsx`

**Interfaces:**
- Consumes: `updateUser(userId, data)` and types `AuthUser`, `UserUpdateInput` from `@/lib/auth-api`.
- Produces: `export function UserEditFlyout(props: { user: AuthUser; isSelf: boolean; onClose: () => void; onSaved: () => void | Promise<void> })`.

- [ ] **Step 1: Write the failing test**

Create `src/components/auth/__tests__/UserEditFlyout.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/auth/__tests__/UserEditFlyout.test.tsx`
Expected: FAIL — cannot resolve `@/components/auth/UserEditFlyout`.

- [ ] **Step 3: Write the component**

Create `src/components/auth/UserEditFlyout.tsx`:

```tsx
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import { Pencil, X } from 'lucide-react'
import { updateUser, type AuthUser, type UserUpdateInput } from '@/lib/auth-api'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface UserEditFlyoutProps {
  user: AuthUser
  isSelf: boolean
  onClose: () => void
  onSaved: () => void | Promise<void>
}

export function UserEditFlyout({ user, isSelf, onClose, onSaved }: UserEditFlyoutProps) {
  const [firstName, setFirstName] = useState(user.first_name ?? '')
  const [lastName, setLastName] = useState(user.last_name ?? '')
  const [email, setEmail] = useState(user.email)
  const [role, setRole] = useState(user.role)
  const [isActive, setIsActive] = useState(user.is_active)
  const [saving, setSaving] = useState(false)

  const emailTrim = email.trim()
  const emailValid = EMAIL_RE.test(emailTrim)

  const patch: UserUpdateInput = {}
  if (firstName.trim() !== (user.first_name ?? '')) patch.first_name = firstName.trim() || null
  if (lastName.trim() !== (user.last_name ?? '')) patch.last_name = lastName.trim() || null
  if (emailTrim !== user.email) patch.email = emailTrim
  if (!isSelf && role !== user.role) patch.role = role
  if (!isSelf && isActive !== user.is_active) patch.is_active = isActive
  const hasChanges = Object.keys(patch).length > 0

  const handleSave = async () => {
    if (!hasChanges || !emailValid) return
    setSaving(true)
    try {
      await updateUser(user.id, patch)
      toast.success(`User ${emailTrim} updated`)
      await onSaved()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update user')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]"
        style={{ animation: 'fadeIn 0.2s ease-out' }}
        onClick={onClose}
      />
      <div
        className="fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l bg-background shadow-xl"
        style={{ animation: 'slideInRight 0.25s ease-out' }}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-6 py-4">
          <div className="flex items-center gap-2">
            <Pencil className="h-5 w-5 text-primary" />
            <span className="text-lg font-semibold">Edit user</span>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-first-name">First name</Label>
              <Input
                id="edit-first-name"
                value={firstName}
                onChange={e => setFirstName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-last-name">Last name</Label>
              <Input
                id="edit-last-name"
                value={lastName}
                onChange={e => setLastName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-email">Email</Label>
              <Input
                id="edit-email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
              {!emailValid && (
                <span className="text-xs text-destructive">
                  Enter a valid email address.
                </span>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-role">Role</Label>
              <Select value={role} onValueChange={setRole} disabled={isSelf}>
                <SelectTrigger id="edit-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-active">Active</Label>
              <Switch
                id="edit-active"
                checked={isActive}
                onCheckedChange={setIsActive}
                disabled={isSelf}
              />
            </div>
            {isSelf && (
              <p className="text-xs text-muted-foreground">
                You can't change your own role or active status.
              </p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={!hasChanges || !emailValid || saving}>
                {saving ? 'Saving...' : 'Save changes'}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
    </>
  )
}

export default UserEditFlyout
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/auth/__tests__/UserEditFlyout.test.tsx`
Expected: PASS (5 tests). If `getByLabelText('Role')`/`('Active')` can't resolve the Radix trigger, fall back to `screen.getByRole('combobox')` / `screen.getByRole('switch')`.

- [ ] **Step 5: Commit**

```bash
git add src/components/auth/UserEditFlyout.tsx src/components/auth/__tests__/UserEditFlyout.test.tsx
git commit -m "feat(users): admin edit-user flyout component"
```

---

### Task 2: Wire the flyout into `UserManagement`

**Files:**
- Modify: `C:\tmp\flag-ui\src\components\auth\UserManagement.tsx`
- Test: `C:\tmp\flag-ui\src\components\auth\__tests__\UserManagement.test.tsx` (create)

**Interfaces:**
- Consumes: `UserEditFlyout` from Task 1; existing `listUsers`, `loadUsers`, `currentUser`.
- Produces: row-click opens the flyout; the role/active toggle icons are removed (reset-password kept).

- [ ] **Step 1: Write the failing test**

Create `src/components/auth/__tests__/UserManagement.test.tsx`:

```tsx
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
  { id: 1, email: 'admin@lab.com', role: 'admin', is_active: true, created_at: '2026-01-01T00:00:00Z', senaite_configured: false, first_name: 'Ada', last_name: 'Min' },
  { id: 2, email: 'jane@lab.com', role: 'standard', is_active: true, created_at: '2026-01-01T00:00:00Z', senaite_configured: false, first_name: 'Jane', last_name: 'Doe' },
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
    expect(screen.getByTitle('Reset password')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/auth/__tests__/UserManagement.test.tsx`
Expected: FAIL — no "Edit user" flyout; promote/demote titles still present.

- [ ] **Step 3: Modify `UserManagement.tsx`**

1. Update the lucide import (drop `User`, `UserX`, `UserCheck`; keep `Plus`, `RotateCcw`, `Shield`):
```tsx
import { Plus, RotateCcw, Shield } from 'lucide-react'
```
2. Add the flyout import after the auth-api import block:
```tsx
import { UserEditFlyout } from '@/components/auth/UserEditFlyout'
```
3. Add selection state next to the other `useState` (after `currentUser`):
```tsx
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const selectedUser = users.find(u => u.id === selectedUserId) ?? null
```
4. Delete the `handleToggleActive` and `handleToggleRole` functions entirely (lines 89-110).
5. Make the row clickable — change `<TableRow key={user.id}>` to:
```tsx
                <TableRow
                  key={user.id}
                  onClick={() => setSelectedUserId(user.id)}
                  className="cursor-pointer"
                >
```
6. Replace the Actions cell inner `<div className="flex justify-end gap-1">…</div>` (the `{user.id !== currentUser?.id && (<>toggles</>)}` block plus the reset button) with just the reset button, `stopPropagation`-guarded:
```tsx
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={e => {
                          e.stopPropagation()
                          handleResetPassword(user)
                        }}
                        title="Reset password"
                      >
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                    </div>
```
7. Render the flyout just before the final closing `</div>` of the component's returned tree (after the `</Card>`):
```tsx
      {selectedUser && (
        <UserEditFlyout
          key={selectedUser.id}
          user={selectedUser}
          isSelf={selectedUser.id === currentUser?.id}
          onClose={() => setSelectedUserId(null)}
          onSaved={loadUsers}
        />
      )}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/auth/__tests__/UserManagement.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Full gate**

Run: `npx vitest run src/components/auth && npx tsc --noEmit && npm run build`
Expected: all green (both auth test files + typecheck + build).

- [ ] **Step 6: Commit**

```bash
git add src/components/auth/UserManagement.tsx src/components/auth/__tests__/UserManagement.test.tsx
git commit -m "feat(users): open edit flyout from User Management rows; fold role/active toggles into it"
```

---

## Self-Review

- **Spec coverage:** trigger (row click) ✓ Task 2; flyout shell mirrors Instruments ✓ Task 1; fields name/email/role/active ✓ Task 1; save via existing `updateUser` minimal patch ✓ Task 1; self-edit guard ✓ Task 1 + test; remove redundant toggles, keep reset ✓ Task 2; email validation ✓ Task 1; tests ✓ both tasks.
- **Placeholders:** none — full component + test code inline.
- **Type consistency:** `updateUser(id, UserUpdateInput)`, `AuthUser` fields, props signature consistent across tasks and match `auth-api.ts` / `auth-store.ts`.
