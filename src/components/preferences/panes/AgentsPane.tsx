import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useAuthStore } from '@/store/auth-store'
import { CrmError } from '@/lib/api-crm'
import { groupKeys, useGroups } from '@/services/groups'
import {
  createAgent,
  listAgents,
  rotateAgentKey,
  setAgentGroups,
  updateAgent,
  type Agent,
  type AgentPatch,
  type AgentWithKey,
} from '@/lib/api-agents'
import { SettingsSection } from '../shared/SettingsComponents'

const QK = ['agents']
const ERRORS: Record<string, string> = {
  invalid_username:
    'Usernames are lowercase letters, digits, - and _ (40 at most).',
  name_taken: 'Another agent already uses that username.',
  coa_needs_lab: 'COA publishing needs Lab tools on.',
  invalid_display_name: 'Give the agent a display name.',
  unknown_group: 'One of those groups is gone or inactive.',
}
const errorText = (e: unknown) =>
  (e instanceof CrmError && e.code && ERRORS[e.code]) ||
  'Could not save. Nothing was changed.'

const when = (iso: string | null) =>
  iso ? new Date(`${iso}Z`).toLocaleString() : 'never'

/** The key, once. Closing it hides it for good: Mk1 keeps only a hash. */
function KeyOnce({
  shown,
  onDone,
}: {
  shown: AgentWithKey
  onDone: () => void
}) {
  const [copied, setCopied] = useState(false)
  const env = `LABMGR_MK1_AGENT_NAME=${shown.agent.username}\nLABMGR_MK1_AGENT_KEY=${shown.key}`
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-amber-500 p-3"
      data-testid="agent-key-once"
    >
      <p className="text-sm font-medium">
        Key for {shown.agent.display_name}. Copy it now: it will not be shown
        again.
      </p>
      <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{env}</pre>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            navigator.clipboard.writeText(env).then(
              () => setCopied(true),
              () => setCopied(false)
            )
          }}
        >
          <Copy className="mr-1 h-3 w-3" />{' '}
          {copied ? 'Copied' : 'Copy settings'}
        </Button>
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}

function NewAgent({ onCreated }: { onCreated: (s: AgentWithKey) => void }) {
  const [username, setUsername] = useState('')
  const [display, setDisplay] = useState('')
  const [lab, setLab] = useState(false)
  const [coa, setCoa] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      onCreated(
        await createAgent({
          username,
          display_name: display,
          lab_tools: lab,
          coa_publishing: lab && coa,
        })
      )
      setUsername('')
      setDisplay('')
      setLab(false)
      setCoa(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="agent-username">Username</Label>
          <Input
            id="agent-username"
            value={username}
            onChange={e => setUsername(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="agent-display">Display name</Label>
          <Input
            id="agent-display"
            value={display}
            onChange={e => setDisplay(e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <Switch
            checked={lab}
            onCheckedChange={v => {
              setLab(v)
              if (!v) setCoa(false)
            }}
            aria-label="Lab tools"
          />
          Lab tools
        </label>
        <label className="flex items-center gap-2">
          <Switch
            checked={coa}
            disabled={!lab}
            onCheckedChange={setCoa}
            aria-label="COA publishing"
          />
          COA publishing
        </label>
      </div>
      {lab && coa && (
        <p className="text-xs text-amber-600">
          Can generate and publish COAs that customers receive.
        </p>
      )}
      <div>
        <Button
          size="sm"
          disabled={busy || !username.trim() || !display.trim()}
          onClick={() => void submit()}
        >
          Create agent
        </Button>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}

function AgentRow({
  agent,
  onKey,
}: {
  agent: Agent
  onKey: (s: AgentWithKey) => void
}) {
  const qc = useQueryClient()
  const groups = useGroups()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const put = (row: Agent) =>
    qc.setQueryData<Agent[]>(QK, old =>
      old?.map(a => (a.id === row.id ? row : a))
    )
  const run = async (fn: () => Promise<Agent | AgentWithKey>) => {
    setBusy(true)
    setError(null)
    try {
      const out = await fn()
      if ('key' in out) {
        put(out.agent)
        onKey(out)
      } else put(out)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const patch = (p: AgentPatch) => void run(() => updateAgent(agent.id, p))
  const toggleGroup = (id: number, on: boolean) => {
    const next = on
      ? [...agent.group_ids, id]
      : agent.group_ids.filter(g => g !== id)
    void run(async () => {
      const out = await setAgentGroups(agent.id, next)
      // The Groups page member editor saves whole lists: a stale one would undo this.
      void qc.invalidateQueries({ queryKey: groupKeys.all })
      return out
    })
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{agent.display_name}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {agent.username}
        </span>
        {!agent.is_active && (
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs">
            Inactive
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          key {agent.key_hint}... · last used {when(agent.last_used_at)}
        </span>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={`Rotate key for ${agent.display_name}`}
            onClick={() => {
              if (
                window.confirm(
                  `Rotate ${agent.display_name}'s key? The current key stops working now.`
                )
              )
                void run(() => rotateAgentKey(agent.id))
            }}
          >
            Rotate key
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => patch({ is_active: !agent.is_active })}
          >
            {agent.is_active ? 'Deactivate' : 'Reactivate'}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <Switch
            checked={agent.lab_tools}
            disabled={busy}
            onCheckedChange={v => patch({ lab_tools: v })}
            aria-label={`Lab tools for ${agent.display_name}`}
          />
          Lab tools
        </label>
        <label className="flex items-center gap-2">
          <Switch
            checked={agent.coa_publishing}
            disabled={busy || !agent.lab_tools}
            onCheckedChange={v => patch({ coa_publishing: v })}
            aria-label={`COA publishing for ${agent.display_name}`}
          />
          COA publishing
        </label>
      </div>
      {(groups.data ?? []).some(g => g.is_active) && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-muted-foreground">
            Groups (restricted spaces):
          </span>
          {(groups.data ?? [])
            .filter(g => g.is_active)
            .map(g => (
              <label key={g.id} className="flex items-center gap-1">
                <Checkbox
                  checked={agent.group_ids.includes(g.id)}
                  disabled={busy}
                  onCheckedChange={v => toggleGroup(g.id, v === true)}
                  aria-label={`${g.name} for ${agent.display_name}`}
                />
                {g.name}
              </label>
            ))}
        </div>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}

/** Settings > Agents: machine users with a key (spec 2026-10-12 section 5). Admins only. */
export function AgentsPane() {
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const qc = useQueryClient()
  const [shown, setShown] = useState<AgentWithKey | null>(null)
  const q = useQuery({
    queryKey: QK,
    queryFn: listAgents,
    enabled: isAdmin,
    retry: false,
  })
  if (!isAdmin)
    return (
      <p className="text-sm text-muted-foreground">
        Only admins can manage agents.
      </p>
    )
  return (
    <SettingsSection title="Machine users">
      <p className="text-sm text-muted-foreground">
        Machine users for AI agents. Each has a username and a key; it can read
        and write documents in the spaces it can see, and only what its switches
        allow.
      </p>
      {shown && (
        <KeyOnce key={shown.key} shown={shown} onDone={() => setShown(null)} />
      )}
      <NewAgent
        onCreated={s => {
          qc.setQueryData<Agent[]>(QK, old => [...(old ?? []), s.agent])
          setShown(s)
        }}
      />
      {q.isLoading && (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      )}
      {q.isError && (
        <p className="text-sm text-red-500">Could not load the agents.</p>
      )}
      <div className="flex flex-col gap-3">
        {(q.data ?? []).map(a => (
          <AgentRow key={a.id} agent={a} onKey={setShown} />
        ))}
      </div>
    </SettingsSection>
  )
}
