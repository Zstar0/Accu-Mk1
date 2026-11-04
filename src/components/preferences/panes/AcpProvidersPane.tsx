import { useId, useState, type ChangeEvent } from 'react'
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { Copy, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/auth-store'
import { CrmError } from '@/lib/api-crm'
import {
  createAcpProvider,
  deleteAcpProvider,
  generateAcpKey,
  listAcpProviders,
  testAcpProvider,
  updateAcpProvider,
  type AcpProvider,
  type AcpProviderInput,
  type AcpProviderList,
  type AcpTestResult,
} from '@/lib/ai-chat-api'
import { SettingsSection } from '../shared/SettingsComponents'

const QK = ['acp-providers']
const NO_KEYS = 'Key storage is not set up on this server.'
// `crmFetch` keeps only `detail.code`, so a 422 `invalid_input` cannot say
// which field it means; the form hints carry the formats instead.
const ERRORS: Record<string, string> = {
  invalid_input:
    'A value was rejected. Check each field against its hint. A slug that is already in use is rejected too.',
  not_supported: 'Mk1 tools are not available until Phase 2.',
  not_ready:
    'This provider needs a passing Test connection first. Turn Enabled off and save, run Test connection, then turn Enabled on again.',
  provider_in_use:
    'This provider has chats, so it cannot be deleted. Disable it instead.',
  provider_not_found: 'This provider no longer exists. Reload the list.',
  keys_not_configured: NO_KEYS,
}
const errorText = (
  e: unknown,
  fallback = 'Could not save. Nothing was changed.'
) => (e instanceof CrmError && e.code && ERRORS[e.code]) || fallback

const when = (iso: string) => new Date(iso).toLocaleString()

/** Capabilities that are on: `true` leaves and empty objects (ACP's way to say "supported"). */
function capabilityNames(caps: Record<string, unknown> | null, prefix = '') {
  return Object.entries(caps ?? {}).flatMap(([key, value]): string[] => {
    const path = prefix + key
    if (value === true) return [path]
    if (value && typeof value === 'object')
      return Object.keys(value).length === 0
        ? [path]
        : capabilityNames(value as Record<string, unknown>, `${path}.`)
    return []
  })
}

const agentLabel = (info: Record<string, unknown> | null) =>
  [info?.name, info?.version].filter(x => typeof x === 'string').join(' ')

function lastTestText(p: AcpProvider): string {
  if (!p.last_test_at) return 'Never tested.'
  const at = when(p.last_test_at)
  if (p.last_test_ok === null)
    return `The ${at} test no longer applies after a change. Run Test connection again.`
  if (!p.last_test_ok)
    return `Last test failed ${at}${p.last_test_error ? `: ${p.last_test_error}` : '.'}`
  const agent = agentLabel(p.last_agent_info)
  const caps = capabilityNames(p.last_capabilities).join(', ')
  return [
    `Last test passed ${at}.`,
    agent && `${agent}.`,
    `Capabilities: ${caps || 'none reported'}.`,
  ]
    .filter(Boolean)
    .join(' ')
}

const upsert = (qc: QueryClient, row: AcpProvider) =>
  qc.setQueryData<AcpProviderList>(QK, old =>
    old
      ? {
          ...old,
          providers: old.providers.some(p => p.id === row.id)
            ? old.providers.map(p => (p.id === row.id ? row : p))
            : [...old.providers, row],
        }
      : old
  )

// ---- form ---------------------------------------------------------------

const ROLES = ['admin', 'standard'] as const
const INT_KEYS = [
  'ssh_port',
  'max_sessions',
  'idle_minutes',
  'permission_timeout_s',
  'agent_approval_timeout_s',
] as const
type IntKey = (typeof INT_KEYS)[number]
type TextKey =
  | IntKey
  | 'slug'
  | 'display_name'
  | 'ssh_host'
  | 'ssh_user'
  | 'host_key'
  | 'launcher_path'
  | 'authorized_from'
  | 'session_cwd'

type FormState = Record<TextKey, string> & { roles: string[]; enabled: boolean }

interface FieldDef {
  key: TextKey
  label: string
  hint: string
  area?: boolean
}

const FIELDS: FieldDef[] = [
  {
    key: 'display_name',
    label: 'Display name',
    hint: 'Shown in the chat panel. 1 to 100 characters.',
  },
  {
    key: 'slug',
    label: 'Slug',
    hint: 'Lowercase letters, digits and dashes, 2 to 32. Fixed once created.',
  },
  {
    key: 'ssh_host',
    label: 'SSH host',
    hint: 'IP address or hostname of the agent host.',
  },
  { key: 'ssh_port', label: 'SSH port', hint: '1 to 65535.' },
  {
    key: 'ssh_user',
    label: 'SSH user',
    hint: 'Lowercase letters, digits, - and _.',
  },
  {
    key: 'host_key',
    label: 'Host key',
    hint: 'Paste the key type and the base64 key only, like ssh-ed25519 AAAA..., without the hostname that ssh-keyscan puts in front.',
    area: true,
  },
  {
    key: 'launcher_path',
    label: 'Launcher path',
    hint: 'Absolute path on the host. Display only: it fills the authorized_keys line.',
  },
  {
    key: 'authorized_from',
    label: 'Authorized from',
    hint: 'IP of this Mk1 server as the host sees it. The key only works from there.',
  },
  {
    key: 'session_cwd',
    label: 'Session directory',
    hint: 'Absolute path the agent works in.',
  },
  { key: 'max_sessions', label: 'Max sessions', hint: '1 to 16 live chats.' },
  {
    key: 'idle_minutes',
    label: 'Idle minutes',
    hint: 'An idle chat session closes after this long. 1 to 240.',
  },
  {
    key: 'permission_timeout_s',
    label: 'Approval timeout (s)',
    hint: 'Mk1 denies an approval card left unanswered this long.',
  },
  {
    key: 'agent_approval_timeout_s',
    label: 'Agent approval timeout (s)',
    hint: "The agent's own approval timeout. Must be above the approval timeout.",
  },
]

const initialForm = (p?: AcpProvider): FormState => ({
  slug: p?.slug ?? '',
  display_name: p?.display_name ?? '',
  ssh_host: p?.ssh_host ?? '',
  ssh_port: String(p?.ssh_port ?? 22),
  ssh_user: p?.ssh_user ?? '',
  host_key: p?.host_key ?? '',
  launcher_path: p?.launcher_path ?? '',
  authorized_from: p?.authorized_from ?? '',
  session_cwd: p?.session_cwd ?? '',
  roles: p?.allowed_roles ?? ['admin'],
  enabled: p?.enabled ?? false,
  max_sessions: String(p?.max_sessions ?? 4),
  idle_minutes: String(p?.idle_minutes ?? 15),
  permission_timeout_s: String(p?.permission_timeout_s ?? 240),
  agent_approval_timeout_s: String(p?.agent_approval_timeout_s ?? 300),
})

/** The whole form. `ProviderIn` is strict: ints go as numbers. `inject_mk1_tools` is Phase 2 and never sent. */
function toInput(f: FormState, create: boolean): AcpProviderInput {
  const t = (k: TextKey) => f[k].trim()
  return {
    ...(create ? { slug: t('slug') } : {}),
    display_name: t('display_name'),
    enabled: f.enabled,
    ssh_host: t('ssh_host'),
    ssh_port: Number(f.ssh_port),
    ssh_user: t('ssh_user'),
    host_key: t('host_key'),
    launcher_path: t('launcher_path'),
    authorized_from: t('authorized_from'),
    session_cwd: t('session_cwd'),
    allowed_roles: ROLES.filter(r => f.roles.includes(r)),
    max_sessions: Number(f.max_sessions),
    idle_minutes: Number(f.idle_minutes),
    permission_timeout_s: Number(f.permission_timeout_s),
    agent_approval_timeout_s: Number(f.agent_approval_timeout_s),
  }
}

// The fields whose change makes the server drop the last test (`_RETEST`).
const RETEST: TextKey[] = [
  'host_key',
  'ssh_host',
  'ssh_port',
  'ssh_user',
  'session_cwd',
]
function changedSinceTest(f: FormState, p: AcpProvider): boolean {
  const saved = initialForm(p)
  // The server compares ints, so "022" is not a change to port 22.
  const differs = (k: TextKey) =>
    (INT_KEYS as readonly string[]).includes(k)
      ? Number(f[k]) !== Number(saved[k])
      : f[k].trim() !== saved[k]
  return (
    RETEST.some(differs) ||
    ROLES.some(r => f.roles.includes(r) !== saved.roles.includes(r))
  )
}

/** Why Enabled cannot go on yet, or null. The server enforces the same rules. */
function enableBlocker(p: AcpProvider | undefined, f: FormState) {
  if (!p) return 'Save the provider, then generate a key.'
  if (!p.public_key) return 'Generate a key first, then install it on the host.'
  if (!p.host_key) return 'Add the host key first.'
  if (f.roles.includes('standard')) {
    if (changedSinceTest(f, p))
      return 'You changed the roles or connection settings. Save, then run Test connection again.'
    if (p.last_test_ok !== true)
      return 'A provider open to standard users needs a passing Test connection first.'
  }
  return null
}

/**
 * Off to on only is gated: a provider that is already on can always be
 * switched off. A disabled switch gets no hover or focus, so the reason hangs
 * off a focusable wrapper (the same element stays mounted either way).
 */
function EnabledSwitch({
  checked,
  blocker,
  onChange,
}: {
  checked: boolean
  blocker: string | null
  onChange: (on: boolean) => void
}) {
  const blocked = !checked && blocker !== null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={blocked ? 0 : undefined}
          data-testid="enabled-reason-trigger"
          className={cn(
            'inline-flex w-fit items-center rounded-md',
            blocked && 'cursor-not-allowed [&>*]:pointer-events-none'
          )}
        >
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={checked}
              disabled={blocked}
              onCheckedChange={onChange}
              aria-label="Enabled"
            />
            Enabled
          </label>
        </span>
      </TooltipTrigger>
      {blocked && (
        <TooltipContent className="max-w-xs p-0">
          <div className="flex flex-col gap-1.5 p-3 font-mono text-xs">
            <div className="border-b border-primary-foreground/20 pb-1.5 font-semibold">
              Cannot enable yet
            </div>
            <div>{blocker}</div>
          </div>
        </TooltipContent>
      )}
    </Tooltip>
  )
}

function ProviderForm({
  provider,
  configured,
  onSaved,
  onCancel,
}: {
  provider?: AcpProvider
  configured: boolean
  onSaved: (row: AcpProvider) => void
  onCancel: () => void
}) {
  const uid = useId()
  const create = provider === undefined
  const [f, setF] = useState(() => initialForm(provider))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setF(s => ({ ...s, [k]: v }))

  const required: TextKey[] = FIELDS.map(d => d.key).filter(
    k => create || k !== 'slug'
  )
  const intOk = (k: IntKey) => /^\d+$/.test(f[k].trim())
  const timeoutsBad =
    intOk('permission_timeout_s') &&
    intOk('agent_approval_timeout_s') &&
    Number(f.permission_timeout_s) >= Number(f.agent_approval_timeout_s)
  const canSave =
    configured &&
    !busy &&
    f.roles.length > 0 &&
    required.every(k => f[k].trim() !== '') &&
    INT_KEYS.every(intOk) &&
    !timeoutsBad

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      onSaved(
        await (provider
          ? updateAcpProvider(provider.id, toInput(f, false))
          : createAcpProvider(toInput(f, true)))
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  // The server refuses this save before writing anything (`not_ready`).
  const retestLost =
    provider !== undefined &&
    f.enabled &&
    f.roles.includes('standard') &&
    changedSinceTest(f, provider)
  const fingerprint = provider?.host_key_fingerprint
  const savedHostKey = provider?.host_key
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <h4 className="text-sm font-medium">
        {create ? 'New provider' : 'Edit provider'}
      </h4>
      {!create && (
        <p className="text-xs text-muted-foreground">
          Test connection and Generate key use the saved settings. Save or
          cancel first.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map(def => {
          const id = `${uid}-${def.key}`
          const common = {
            id,
            value: f[def.key],
            autoComplete: 'off',
            spellCheck: false,
            onChange: (
              e: ChangeEvent<HTMLInputElement & HTMLTextAreaElement>
            ) => set(def.key, e.target.value),
          }
          const isInt = (INT_KEYS as readonly string[]).includes(def.key)
          return (
            <div key={def.key} className="flex flex-col gap-1">
              <Label htmlFor={id}>{def.label}</Label>
              {def.area ? (
                <Textarea {...common} rows={2} className="font-mono text-xs" />
              ) : (
                <Input
                  {...common}
                  type={isInt ? 'number' : 'text'}
                  disabled={def.key === 'slug' && !create}
                />
              )}
              <p className="text-xs text-muted-foreground">{def.hint}</p>
              {def.key === 'host_key' &&
                fingerprint &&
                (f.host_key.trim() === savedHostKey ? (
                  <p className="text-xs">
                    Fingerprint: <code>{fingerprint}</code>
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    The fingerprint shows after you save.
                  </p>
                ))}
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="text-muted-foreground">Allowed roles:</span>
        {ROLES.map(role => (
          <label key={role} className="flex items-center gap-2 capitalize">
            <Checkbox
              checked={f.roles.includes(role)}
              onCheckedChange={on =>
                set(
                  'roles',
                  on === true
                    ? [...f.roles, role]
                    : f.roles.filter(r => r !== role)
                )
              }
            />
            {role}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Standard also lets non-admin users chat with it. It then needs a passing
        Test connection before it can be enabled.
      </p>
      <div className="flex flex-wrap items-center gap-6">
        <EnabledSwitch
          checked={f.enabled}
          blocker={enableBlocker(provider, f)}
          onChange={on => set('enabled', on)}
        />
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={false} disabled aria-label="Mk1 tools" />
          Mk1 tools
          <span className="text-xs text-muted-foreground">Phase 2</span>
        </label>
      </div>
      {retestLost && (
        <p className="text-xs text-amber-600">
          Changing the roles or connection settings removes the passing test, so
          this provider cannot stay enabled. Turn Enabled off to save, then test
          and enable it again.
        </p>
      )}
      {timeoutsBad && (
        <p className="text-xs text-red-500">
          Approval timeout must be below the agent timeout.
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={!canSave} onClick={() => void save()}>
          {create ? 'Create provider' : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}

// ---- list ---------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false)
        )
      }}
    >
      <Copy className="mr-1 h-3 w-3" /> {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

const label = (key: string) => {
  const words = key.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** `stderr_tail` comes from the agent side: text in a `<pre>`, never markup. */
function TestReport({ r }: { r: AcpTestResult }) {
  const timings = Object.entries(r.timings_ms).filter(
    (e): e is [string, number] => e[1] !== null
  )
  const agent = agentLabel(r.agent_info)
  const caps = capabilityNames(r.capabilities)
  return (
    <div
      data-testid="test-report"
      className="flex flex-col gap-1 rounded-md border p-3 text-xs"
    >
      <p className={r.ok ? 'text-emerald-600' : 'text-red-500'}>
        {r.ok ? 'Test passed.' : `Test failed: ${r.error ?? 'unknown error'}`}
      </p>
      {agent && <p>Agent: {agent}</p>}
      {timings.length > 0 && (
        <p>{timings.map(([k, ms]) => `${label(k)} ${ms} ms`).join(', ')}</p>
      )}
      {/* A failed tool check names one offender; the whole list lets an admin fix them all in one go. */}
      {(r.ok || caps.length > 0) && (
        <p>Capabilities: {caps.join(', ') || 'none reported'}</p>
      )}
      {(r.ok || r.tools.length > 0) && (
        <p className="break-words">
          Tool list: {r.tools.join(', ') || 'empty'}
        </p>
      )}
      {!r.ok && r.stderr_tail && r.stderr_tail.length > 0 && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono">
          {r.stderr_tail.join('\n')}
        </pre>
      )}
    </div>
  )
}

function ProviderCard({
  p,
  configured,
}: {
  p: AcpProvider
  configured: boolean
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<AcpTestResult | null>(null)

  const run = async (
    status: string,
    fallback: string,
    action: () => Promise<void>
  ) => {
    setBusy(status)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorText(e, fallback))
    } finally {
      setBusy(null)
    }
  }

  const generate = () => {
    const replaces = p.public_key
      ? 'This replaces the existing key, so the line now installed on the host stops working. '
      : ''
    if (
      !window.confirm(
        `Generate a new key for ${p.display_name}? ${replaces}A provider open to standard users is disabled until it passes a new test. Install the new line on the host afterwards.`
      )
    )
      return
    void run(
      'Generating the key...',
      'Could not generate the key. Nothing was changed.',
      async () => {
        upsert(qc, await generateAcpKey(p.id))
        setReport(null) // it described the old key
      }
    )
  }

  // No client timeout: the test can run for about 110 s.
  const test = () => {
    setReport(null)
    void run(
      'Testing the connection. This can take up to two minutes.',
      'Could not run the test.',
      async () => {
        try {
          setReport(await testAcpProvider(p.id))
        } finally {
          // The server records the result; the standard-role gate reads it.
          void qc.invalidateQueries({ queryKey: QK })
        }
      }
    )
  }

  const remove = () => {
    if (
      !window.confirm(
        `Delete ${p.display_name}? Remove its line from authorized_keys on the host too.`
      )
    )
      return
    void run(
      'Deleting...',
      'Could not delete. Nothing was changed.',
      async () => {
        await deleteAcpProvider(p.id)
        qc.setQueryData<AcpProviderList>(
          QK,
          old =>
            old && {
              ...old,
              providers: old.providers.filter(x => x.id !== p.id),
            }
        )
      }
    )
  }

  const idle = busy === null
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{p.display_name}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {p.slug}
        </span>
        <span className="rounded-md bg-muted px-2 py-0.5 text-xs">
          {p.enabled ? 'Enabled' : 'Disabled'}
        </span>
        <span className="text-xs text-muted-foreground">
          Roles: {p.allowed_roles.join(', ')}
        </span>
        <span className="text-xs text-muted-foreground">
          {`${p.live_sessions} live ${p.live_sessions === 1 ? 'session' : 'sessions'}`}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={editing}
            aria-label={`Edit ${p.display_name}`}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!configured || !idle || editing}
            aria-label={`Generate key for ${p.display_name}`}
            onClick={generate}
          >
            Generate key
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!idle || editing || !p.public_key || !p.host_key}
            aria-label={`Test connection for ${p.display_name}`}
            onClick={test}
          >
            Test connection
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!idle}
            aria-label={`Delete ${p.display_name}`}
            onClick={remove}
          >
            Delete
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="last-test">
        {lastTestText(p)}
      </p>
      {p.authorized_keys_line ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            Install this line in authorized_keys on the host. It holds the
            public key only.
          </p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">
            {p.authorized_keys_line}
          </pre>
          <div>
            <CopyButton
              key={p.authorized_keys_line}
              text={p.authorized_keys_line}
            />
          </div>
        </div>
      ) : p.public_key ? (
        <p className="text-xs text-amber-600">
          The authorized_keys line could not be built. Check the launcher path
          and Authorized from.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          No key yet. Generate a key, install its line on the host, then run
          Test connection.
        </p>
      )}
      {busy && (
        <p
          role="status"
          className="flex items-center gap-1 text-xs text-muted-foreground"
        >
          <Loader2 className="h-3 w-3 animate-spin" /> {busy}
        </p>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
      {report && <TestReport r={report} />}
      {editing && (
        <ProviderForm
          key={p.updated_at}
          provider={p}
          configured={configured}
          onSaved={row => {
            upsert(qc, row)
            setReport(null) // it described the old settings
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  )
}

/** Settings > ACP Providers: the agents the AI chat panel can reach over SSH. Admins only. */
export function AcpProvidersPane() {
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const q = useQuery({
    queryKey: QK,
    queryFn: listAcpProviders,
    enabled: isAdmin,
    retry: false,
  })
  if (!isAdmin)
    return (
      <p className="text-sm text-muted-foreground">
        Only admins can manage ACP providers.
      </p>
    )
  return (
    <SettingsSection title="ACP providers">
      <p className="text-sm text-muted-foreground">
        Agents the AI chat panel connects to over SSH. Add a provider, generate
        its key, install the key line on the agent host, run Test connection,
        then enable it.
      </p>
      {q.isLoading && (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      )}
      {q.isError && (
        <p className="text-sm text-red-500">Could not load the providers.</p>
      )}
      {q.data && !q.data.configured && (
        <p className="text-sm text-amber-600">{NO_KEYS}</p>
      )}
      {q.data && (
        <>
          <div className="flex flex-col gap-3">
            {q.data.providers.map(p => (
              <ProviderCard key={p.id} p={p} configured={q.data.configured} />
            ))}
          </div>
          {adding ? (
            <ProviderForm
              configured={q.data.configured}
              onSaved={row => {
                upsert(qc, row)
                setAdding(false)
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <div>
              <Button
                size="sm"
                disabled={!q.data.configured}
                onClick={() => setAdding(true)}
              >
                Add provider
              </Button>
            </div>
          )}
        </>
      )}
    </SettingsSection>
  )
}
