import { useState, type FormEvent } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { CheckCircle2, Loader2, User } from 'lucide-react'
import { changePassword, setSenaitePassword, clearSenaitePassword } from '@/lib/auth-api'
import { useAuthStore } from '@/store/auth-store'

export function ProfilePage() {
  const user = useAuthStore(state => state.user)

  return (
    <div className="p-6 space-y-6 max-w-lg">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <User className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">Profile</h1>
          <p className="text-sm text-muted-foreground">{user?.email}</p>
        </div>
      </div>

      <ChangePasswordSection />
      <SenaiteCredentialsSection />
    </div>
  )
}

function ChangePasswordSection() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match')
      return
    }
    if (newPassword.length < 8) {
      toast.error('Password must be at least 8 characters')
      return
    }

    setIsSubmitting(true)
    try {
      await changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      })
      toast.success('Password changed successfully')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to change password')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Change Password</CardTitle>
        <CardDescription>Update your account password</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="current">Current Password</Label>
            <Input
              id="current"
              type="password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new">New Password</Label>
            <Input
              id="new"
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              required
              placeholder="Minimum 8 characters"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm">Confirm New Password</Label>
            <Input
              id="confirm"
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={isSubmitting} className="self-start">
            {isSubmitting ? 'Changing...' : 'Change Password'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function SenaiteCredentialsSection() {
  const user = useAuthStore(state => state.user)
  const [showInput, setShowInput] = useState(false)
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!password.trim()) return
    setSaving(true)
    try {
      await setSenaitePassword(password.trim())
      toast.success('Senaite credentials saved')
      setPassword('')
      setShowInput(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save credentials')
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    try {
      await clearSenaitePassword()
      toast.success('Senaite credentials removed')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to clear credentials')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Senaite Integration</CardTitle>
        <CardDescription>
          Store your Senaite password so changes you make are attributed to your
          account instead of the admin user.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {user?.senaite_configured && !showInput ? (
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-500">
              <CheckCircle2 className="h-4 w-4" />
              Credentials configured
            </span>
            <Button variant="outline" size="sm" onClick={handleClear}>
              Remove
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowInput(true)}>
              Update
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Input
                type="password"
                placeholder="Enter your Senaite password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
                className="flex-1"
                disabled={saving}
              />
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!password.trim() || saving}
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                {saving ? 'Verifying...' : 'Save'}
              </Button>
              {showInput && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setShowInput(false); setPassword('') }}
                >
                  Cancel
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Your password is verified against Senaite before saving and stored encrypted.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
