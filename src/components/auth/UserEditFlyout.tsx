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

export function UserEditFlyout({
  user,
  isSelf,
  onClose,
  onSaved,
}: UserEditFlyoutProps) {
  const [firstName, setFirstName] = useState(user.first_name ?? '')
  const [lastName, setLastName] = useState(user.last_name ?? '')
  const [email, setEmail] = useState(user.email)
  const [role, setRole] = useState(user.role)
  const [isActive, setIsActive] = useState(user.is_active)
  const [saving, setSaving] = useState(false)

  const emailTrim = email.trim()
  const emailValid = EMAIL_RE.test(emailTrim)

  const patch: UserUpdateInput = {}
  if (firstName.trim() !== (user.first_name ?? ''))
    patch.first_name = firstName.trim() || null
  if (lastName.trim() !== (user.last_name ?? ''))
    patch.last_name = lastName.trim() || null
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
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close"
          >
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
                You cannot change your own role or active status.
              </p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={!hasChanges || !emailValid || saving}
              >
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
