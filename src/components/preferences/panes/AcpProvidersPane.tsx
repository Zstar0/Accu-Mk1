import { useId, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
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
import { PROVIDERS_KEY } from '@/components/ai-chat/use-ai-chat-glue'
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
// `crmFetch` keeps only `detail.code`, so a 422 `invalid_input` cannot say
// which field it means; the form hints carry the formats instead.
const ERRORS: Record<string, string> = {
  invalid_input: 'preferences.acpProviders.error.invalidInput',
  not_supported: 'preferences.acpProviders.error.notSupported',
  not_ready: 'preferences.acpProviders.error.notReady',
  provider_in_use: 'preferences.acpProviders.error.providerInUse',
  provider_not_found: 'preferences.acpProviders.error.providerNotFound',
  keys_not_configured: 'preferences.acpProviders.noKeys',
}
/** `fallback` and the `ERRORS` values are translation keys. */
const errorText = (
  e: unknown,
  t: TFunction,
  fallback = 'preferences.acpProviders.error.saveFailed'
) => t((e instanceof CrmError && e.code && ERRORS[e.code]) || fallback)

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

function lastTestText(p: AcpProvider, t: TFunction): string {
  if (!p.last_test_at) return t('preferences.acpProviders.lastTest.never')
  const at = when(p.last_test_at)
  if (p.last_test_ok === null)
    return t('preferences.acpProviders.lastTest.stale', { at })
  if (!p.last_test_ok)
    return p.last_test_error
      ? t('preferences.acpProviders.lastTest.failedWithError', {
          at,
          error: p.last_test_error,
        })
      : t('preferences.acpProviders.lastTest.failed', { at })
  const agent = agentLabel(p.last_agent_info)
  const caps = capabilityNames(p.last_capabilities).join(', ')
  return [
    t('preferences.acpProviders.lastTest.passed', { at }),
    agent && `${agent}.`,
    t('preferences.acpProviders.lastTest.capabilities', {
      caps: caps || t('preferences.acpProviders.noneReported'),
    }),
  ]
    .filter(Boolean)
    .join(' ')
}

/** The chat button reads its own list: a write here must reach it without a reload. */
const refreshChatButton = (qc: QueryClient) =>
  void qc.invalidateQueries({ queryKey: PROVIDERS_KEY })

const upsert = (qc: QueryClient, row: AcpProvider) => {
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
  refreshChatButton(qc)
}

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
  /** Translation keys. */
  label: string
  hint: string
  area?: boolean
}

const FIELDS: FieldDef[] = [
  {
    key: 'display_name',
    label: 'preferences.acpProviders.displayName.label',
    hint: 'preferences.acpProviders.displayName.description',
  },
  {
    key: 'slug',
    label: 'preferences.acpProviders.slug.label',
    hint: 'preferences.acpProviders.slug.description',
  },
  {
    key: 'ssh_host',
    label: 'preferences.acpProviders.sshHost.label',
    hint: 'preferences.acpProviders.sshHost.description',
  },
  {
    key: 'ssh_port',
    label: 'preferences.acpProviders.sshPort.label',
    hint: 'preferences.acpProviders.sshPort.description',
  },
  {
    key: 'ssh_user',
    label: 'preferences.acpProviders.sshUser.label',
    hint: 'preferences.acpProviders.sshUser.description',
  },
  {
    key: 'host_key',
    label: 'preferences.acpProviders.hostKey.label',
    hint: 'preferences.acpProviders.hostKey.description',
    area: true,
  },
  {
    key: 'launcher_path',
    label: 'preferences.acpProviders.launcherPath.label',
    hint: 'preferences.acpProviders.launcherPath.description',
  },
  {
    key: 'authorized_from',
    label: 'preferences.acpProviders.authorizedFrom.label',
    hint: 'preferences.acpProviders.authorizedFrom.description',
  },
  {
    key: 'session_cwd',
    label: 'preferences.acpProviders.sessionCwd.label',
    hint: 'preferences.acpProviders.sessionCwd.description',
  },
  {
    key: 'max_sessions',
    label: 'preferences.acpProviders.maxSessions.label',
    hint: 'preferences.acpProviders.maxSessions.description',
  },
  {
    key: 'idle_minutes',
    label: 'preferences.acpProviders.idleMinutes.label',
    hint: 'preferences.acpProviders.idleMinutes.description',
  },
  {
    key: 'permission_timeout_s',
    label: 'preferences.acpProviders.permissionTimeout.label',
    hint: 'preferences.acpProviders.permissionTimeout.description',
  },
  {
    key: 'agent_approval_timeout_s',
    label: 'preferences.acpProviders.agentApprovalTimeout.label',
    hint: 'preferences.acpProviders.agentApprovalTimeout.description',
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

/** The key of why Enabled cannot go on yet, or null. The server enforces the same rules. */
function enableBlocker(p: AcpProvider | undefined, f: FormState) {
  if (!p) return 'preferences.acpProviders.blocker.notSaved'
  if (!p.public_key) return 'preferences.acpProviders.blocker.noKey'
  if (!p.host_key) return 'preferences.acpProviders.blocker.noHostKey'
  if (f.roles.includes('standard')) {
    if (changedSinceTest(f, p))
      return 'preferences.acpProviders.blocker.changed'
    if (p.last_test_ok !== true)
      return 'preferences.acpProviders.blocker.untested'
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
  const { t } = useTranslation()
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
              aria-label={t('common.enabled')}
            />
            {t('common.enabled')}
          </label>
        </span>
      </TooltipTrigger>
      {blocked && (
        <TooltipContent className="max-w-xs p-0">
          <div className="flex flex-col gap-1.5 p-3 font-mono text-xs">
            <div className="border-b border-primary-foreground/20 pb-1.5 font-semibold">
              {t('preferences.acpProviders.cannotEnable')}
            </div>
            <div>{t(blocker)}</div>
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
  const { t } = useTranslation()
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
      setError(errorText(e, t))
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
        {create
          ? t('preferences.acpProviders.newProvider')
          : t('preferences.acpProviders.editProvider')}
      </h4>
      {!create && (
        <p className="text-xs text-muted-foreground">
          {t('preferences.acpProviders.editNote')}
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
              <Label htmlFor={id}>{t(def.label)}</Label>
              {def.area ? (
                <Textarea {...common} rows={2} className="font-mono text-xs" />
              ) : (
                <Input
                  {...common}
                  type={isInt ? 'number' : 'text'}
                  disabled={def.key === 'slug' && !create}
                />
              )}
              <p className="text-xs text-muted-foreground">{t(def.hint)}</p>
              {def.key === 'host_key' &&
                fingerprint &&
                (f.host_key.trim() === savedHostKey ? (
                  <p className="text-xs">
                    {t('preferences.acpProviders.fingerprint')}{' '}
                    <code>{fingerprint}</code>
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('preferences.acpProviders.fingerprintAfterSave')}
                  </p>
                ))}
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="text-muted-foreground">
          {t('preferences.acpProviders.allowedRoles')}
        </span>
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
            {t(`preferences.acpProviders.role.${role}`)}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {t('preferences.acpProviders.standardNote')}
      </p>
      <div className="flex flex-wrap items-center gap-6">
        <EnabledSwitch
          checked={f.enabled}
          blocker={enableBlocker(provider, f)}
          onChange={on => set('enabled', on)}
        />
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={false}
            disabled
            aria-label={t('preferences.acpProviders.mk1Tools')}
          />
          {t('preferences.acpProviders.mk1Tools')}
          <span className="text-xs text-muted-foreground">
            {t('preferences.acpProviders.phase2')}
          </span>
        </label>
      </div>
      {retestLost && (
        <p className="text-xs text-amber-600">
          {t('preferences.acpProviders.retestLost')}
        </p>
      )}
      {timeoutsBad && (
        <p className="text-xs text-red-500">
          {t('preferences.acpProviders.timeoutsBad')}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={!canSave} onClick={() => void save()}>
          {create
            ? t('preferences.acpProviders.createProvider')
            : t('preferences.acpProviders.save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('preferences.acpProviders.cancel')}
        </Button>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}

// ---- list ---------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation()
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
      <Copy className="me-1 h-3 w-3" />{' '}
      {copied
        ? t('preferences.acpProviders.copied')
        : t('preferences.acpProviders.copy')}
    </Button>
  )
}

const label = (key: string) => {
  const words = key.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** `stderr_tail` comes from the agent side: text in a `<pre>`, never markup. */
function TestReport({ r }: { r: AcpTestResult }) {
  const { t } = useTranslation()
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
        {r.ok
          ? t('preferences.acpProviders.test.passed')
          : t('preferences.acpProviders.test.failed', {
              error: r.error ?? t('preferences.acpProviders.test.unknownError'),
            })}
      </p>
      {agent && <p>{t('preferences.acpProviders.test.agent', { agent })}</p>}
      {timings.length > 0 && (
        <p>{timings.map(([k, ms]) => `${label(k)} ${ms} ms`).join(', ')}</p>
      )}
      {/* A failed tool check names one offender; the whole list lets an admin fix them all in one go. */}
      {(r.ok || caps.length > 0) && (
        <p>
          {t('preferences.acpProviders.test.capabilities', {
            caps: caps.join(', ') || t('preferences.acpProviders.noneReported'),
          })}
        </p>
      )}
      {(r.ok || r.tools.length > 0) && (
        <p className="break-words">
          {t('preferences.acpProviders.test.tools', {
            tools:
              r.tools.join(', ') ||
              t('preferences.acpProviders.test.toolsEmpty'),
          })}
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
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<AcpTestResult | null>(null)

  /** `status` is shown while it runs; `fallback` is the key of the error text. */
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
      setError(errorText(e, t, fallback))
    } finally {
      setBusy(null)
    }
  }

  const generate = () => {
    const confirmKey = p.public_key
      ? 'preferences.acpProviders.confirmRegenerate'
      : 'preferences.acpProviders.confirmGenerate'
    if (!window.confirm(t(confirmKey, { name: p.display_name }))) return
    void run(
      t('preferences.acpProviders.generating'),
      'preferences.acpProviders.error.generateFailed',
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
      t('preferences.acpProviders.testing'),
      'preferences.acpProviders.error.testFailed',
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
        t('preferences.acpProviders.confirmDelete', { name: p.display_name })
      )
    )
      return
    void run(
      t('preferences.acpProviders.deleting'),
      'preferences.acpProviders.error.deleteFailed',
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
        refreshChatButton(qc)
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
          {p.enabled ? t('common.enabled') : t('common.disabled')}
        </span>
        <span className="text-xs text-muted-foreground">
          {t('preferences.acpProviders.roles', {
            // An unknown role from the server shows as it is.
            roles: p.allowed_roles
              .map(r =>
                t(`preferences.acpProviders.role.${r}`, { defaultValue: r })
              )
              .join(', '),
          })}
        </span>
        <span className="text-xs text-muted-foreground">
          {t('preferences.acpProviders.liveSessions', {
            count: p.live_sessions,
          })}
        </span>
        <div className="ms-auto flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={editing}
            aria-label={t('preferences.acpProviders.editAria', {
              name: p.display_name,
            })}
            onClick={() => setEditing(true)}
          >
            {t('preferences.acpProviders.edit')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!configured || !idle || editing}
            aria-label={t('preferences.acpProviders.generateKeyAria', {
              name: p.display_name,
            })}
            onClick={generate}
          >
            {t('preferences.acpProviders.generateKey')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!idle || editing || !p.public_key || !p.host_key}
            aria-label={t('preferences.acpProviders.testConnectionAria', {
              name: p.display_name,
            })}
            onClick={test}
          >
            {t('preferences.acpProviders.testConnection')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!idle}
            aria-label={t('preferences.acpProviders.deleteAria', {
              name: p.display_name,
            })}
            onClick={remove}
          >
            {t('preferences.acpProviders.delete')}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="last-test">
        {lastTestText(p, t)}
      </p>
      {p.authorized_keys_line ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            {t('preferences.acpProviders.installLine')}
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
          {t('preferences.acpProviders.lineUnbuilt')}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t('preferences.acpProviders.noKeyYet')}
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
  const { t } = useTranslation()
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
        {t('preferences.acpProviders.adminOnly')}
      </p>
    )
  return (
    <SettingsSection title={t('preferences.acpProviders.title')}>
      <p className="text-sm text-muted-foreground">
        {t('preferences.acpProviders.intro')}
      </p>
      {q.isLoading && (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      )}
      {q.isError && (
        <p className="text-sm text-red-500">
          {t('preferences.acpProviders.loadError')}
        </p>
      )}
      {q.data && !q.data.configured && (
        <p className="text-sm text-amber-600">
          {t('preferences.acpProviders.noKeys')}
        </p>
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
                {t('preferences.acpProviders.addProvider')}
              </Button>
            </div>
          )}
        </>
      )}
    </SettingsSection>
  )
}
