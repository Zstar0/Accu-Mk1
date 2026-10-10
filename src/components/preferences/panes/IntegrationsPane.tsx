import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuthStore } from '@/store/auth-store'
import { CrmError } from '@/lib/api-crm'
import {
  clearIntegrationKey,
  getIntegrationKeys,
  saveIntegrationKey,
  testIntegrationKey,
  type IntegrationKeyList,
  type IntegrationKeyStatus,
} from '@/lib/api-integration-keys'
import { SettingsSection } from '../shared/SettingsComponents'

const QK = ['integration-keys']
const SOURCE = {
  settings: 'Saved in Settings',
  env: 'From server env',
  none: 'Not set',
} as const

function saveError(e: unknown, label: string): string {
  const code = e instanceof CrmError ? e.code : null
  if (code === 'key_rejected') return `${label} rejected this key.`
  if (code === 'provider_unavailable')
    return `${label} is not answering; nothing was saved.`
  if (code === 'invalid_input')
    return 'Paste a key first (512 characters at most).'
  if (code === 'keys_not_configured')
    return 'Key storage is not set up on this server.'
  return 'Could not save. Nothing was changed.'
}

const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })
    : ''

function KeyRow({
  k,
  configured,
}: {
  k: IntegrationKeyStatus
  configured: boolean
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const put = (row: IntegrationKeyStatus) =>
    qc.setQueryData<IntegrationKeyList>(QK, old =>
      old
        ? { ...old, keys: old.keys.map(x => (x.name === row.name ? row : x)) }
        : old
    )

  const save = async () => {
    setBusy(`Testing with ${k.label}...`)
    setMsg(null)
    try {
      put(await saveIntegrationKey(k.name, value))
      setValue('')
      setEditing(false)
      setMsg({ ok: true, text: 'Saved and working.' })
    } catch (e) {
      setMsg({ ok: false, text: saveError(e, k.label) })
    } finally {
      setBusy(null)
    }
  }

  const test = async () => {
    setBusy('Testing...')
    setMsg(null)
    try {
      const r = await testIntegrationKey(k.name)
      const text = {
        ok: 'Working.',
        rejected: `${k.label} rejected the key in use.`,
        unavailable: `${k.label} is not answering.`,
        not_set: 'No key is set.',
      }[r.outcome]
      setMsg({ ok: r.ok, text })
    } catch {
      setMsg({ ok: false, text: 'Could not run the test.' })
    } finally {
      setBusy(null)
    }
  }

  const revert = async () => {
    setBusy('Switching to the server env...')
    setMsg(null)
    try {
      put(await clearIntegrationKey(k.name))
    } catch {
      setMsg({ ok: false, text: 'Could not switch. Nothing was changed.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{k.label}</span>
        <span className="rounded-md bg-muted px-2 py-0.5 text-xs">
          {SOURCE[k.source]}
        </span>
        {k.last4 && (
          <span className="text-xs text-muted-foreground">
            ends in {k.last4}
          </span>
        )}
        {k.updated_by_name && (
          <span className="text-xs text-muted-foreground">
            Updated by {k.updated_by_name}, {day(k.updated_at)}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!configured || busy !== null}
            onClick={() => setEditing(e => !e)}
          >
            Replace
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void test()}
          >
            Test
          </Button>
          {k.source === 'settings' && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void revert()}
            >
              Use server env
            </Button>
          )}
        </div>
      </div>
      {k.undecryptable && (
        <p className="text-xs text-amber-600">
          The saved key can&apos;t be read (the encryption key changed). Using the
          server env value. Replace it to fix.
        </p>
      )}
      {editing && (
        <div className="flex gap-2">
          <Input
            type="password"
            autoComplete="off"
            aria-label={`New ${k.label} key`}
            value={value}
            onChange={e => setValue(e.target.value)}
          />
          <Button
            size="sm"
            disabled={!value.trim() || busy !== null}
            onClick={() => void save()}
          >
            Save and test
          </Button>
        </div>
      )}
      {busy && (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> {busy}
        </p>
      )}
      {msg && (
        <p
          className={
            msg.ok ? 'text-xs text-emerald-600' : 'text-xs text-red-500'
          }
        >
          {msg.text}
        </p>
      )}
    </div>
  )
}

/** Settings > Integrations: third-party API keys, write-only (spec 2026-10-10 section 5). */
export function IntegrationsPane() {
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const q = useQuery({
    queryKey: QK,
    queryFn: getIntegrationKeys,
    enabled: isAdmin,
    retry: false,
  })
  if (!isAdmin)
    return (
      <p className="text-sm text-muted-foreground">
        Only admins can manage integration keys.
      </p>
    )
  return (
    <SettingsSection title="API keys">
      {q.isLoading && (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      )}
      {q.isError && (
        <p className="text-sm text-red-500">
          Could not load the integration keys.
        </p>
      )}
      {q.data && !q.data.configured && (
        <p className="text-sm text-amber-600">
          Key storage is not set up on this server (INTEGRATION_KEYS_SECRET is
          missing). Keys still come from the server env.
        </p>
      )}
      {q.data && (
        <div className="flex flex-col gap-3">
          {q.data.keys.map(k => (
            <KeyRow key={k.name} k={k} configured={q.data.configured} />
          ))}
        </div>
      )}
    </SettingsSection>
  )
}
