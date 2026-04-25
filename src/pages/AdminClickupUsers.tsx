import { useState } from 'react'
import {
  useUnmappedClickupUsers,
  useMapClickupUser,
} from '@/hooks/clickup-users'

export function AdminClickupUsers() {
  const { data, isLoading, isError } = useUnmappedClickupUsers()
  const map = useMapClickupUser()
  const [inputs, setInputs] = useState<Record<string, string>>({})

  const onSave = (clickupUserId: string) => {
    const raw = inputs[clickupUserId]
    if (!raw) return
    const parsed = parseInt(raw, 10)
    if (!Number.isFinite(parsed)) return
    map.mutate({ clickupUserId, accumk1UserId: parsed })
  }

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-semibold mb-4">ClickUp User Mapping</h1>
      <p className="text-sm text-muted-foreground mb-4">
        Unmapped ClickUp users. Enter the Accu-Mk1 user ID to link.
      </p>
      {isLoading && <p>Loading…</p>}
      {isError && <p>Error loading users.</p>}
      {data && data.length === 0 && (
        <p className="text-muted-foreground">All ClickUp users are mapped.</p>
      )}
      {data && data.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="text-left py-2">ClickUp user</th>
              <th className="text-left py-2">Email</th>
              <th className="text-left py-2">Auto-matched</th>
              <th className="text-left py-2">Accu-Mk1 user ID</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map(u => (
              <tr key={u.clickup_user_id} className="border-b">
                <td className="py-2">{u.clickup_username}</td>
                <td>{u.clickup_email ?? '—'}</td>
                <td>{u.auto_matched ? '✓' : '—'}</td>
                <td>
                  <input
                    type="number"
                    className="border rounded px-2 py-1"
                    value={inputs[u.clickup_user_id] ?? ''}
                    onChange={e =>
                      setInputs({
                        ...inputs,
                        [u.clickup_user_id]: e.target.value,
                      })
                    }
                    placeholder="User ID"
                  />
                </td>
                <td>
                  <button
                    className="px-3 py-1 bg-primary text-primary-foreground rounded"
                    onClick={() => onSave(u.clickup_user_id)}
                    disabled={map.isPending}
                  >
                    Save
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
