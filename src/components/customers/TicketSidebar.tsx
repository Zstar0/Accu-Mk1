import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronDown,
  CircleCheck,
  Clock,
  Loader2,
  Reply,
  X,
} from 'lucide-react'
import {
  getSupportWorkspace,
  type SupportAction,
  type SupportThread,
} from '@/lib/api-support'
import { cn } from '@/lib/utils'
import { PlainAvatar } from './PlainAvatar'
import { supportErrorMessage } from './support-errors'
import { exact } from './plain-time'
import { SNOOZE_PRESETS } from './snooze-presets'

type Run = (
  action: SupportAction,
  body: Record<string, unknown>
) => Promise<void>

const sel =
  'rounded-md border border-[var(--pv-border)] bg-[var(--pv-surface)] px-2 py-1 text-sm'
const FIRST_FIELDS = 5

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-start gap-2 py-1 text-sm">
      <dt className="font-medium text-[var(--pv-ink-2)]">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="border-b border-[var(--pv-border)] px-4 py-3">
      <button
        type="button"
        className="flex w-full items-center justify-between font-semibold"
        onClick={() => setOpen(o => !o)}
      >
        {title}
        <ChevronDown
          className={cn('h-4 w-4 transition-transform', !open && '-rotate-90')}
        />
      </button>
      {open && <div className="mt-2">{children}</div>}
    </section>
  )
}

const statusIcon = (status: string) =>
  status === 'done' ? CircleCheck : status === 'snoozed' ? Clock : Reply

/** Plain's right-hand details: thread details, customer details, recent threads (spec 4.3). */
export function TicketSidebar({
  thread,
  threads,
  canEdit,
  run,
  onSelect,
}: {
  thread: SupportThread
  threads: SupportThread[]
  canEdit: boolean
  run: Run
  onSelect: (t: SupportThread) => void
}) {
  const ws = useQuery({
    queryKey: ['support', 'workspace'],
    queryFn: getSupportWorkspace,
    staleTime: 600_000,
    enabled: canEdit,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [moreFields, setMoreFields] = useState(false)
  const [customUntil, setCustomUntil] = useState<string | null>(null)

  const act = async (action: SupportAction, body: Record<string, unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await run(action, body)
    } catch (e) {
      setError(supportErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const onStatus = (v: string) => {
    if (v === 'open') return void act('status', { status: 'todo' })
    if (v === 'done' || v === 'waiting_for_customer')
      return void act('status', { status: v })
    const preset = SNOOZE_PRESETS[v]
    if (preset)
      return void act('status', { status: 'snoozed', until: preset() })
    if (v === 'snooze:custom') setCustomUntil('')
  }

  const detail = thread.status_detail
  const assignees = thread.assignees ?? []
  const primary = assignees.find(a => a.primary)
  const extra = assignees.filter(a => !a.primary)
  const refs = thread.label_refs ?? []
  const fields = thread.fields ?? []
  const shown = moreFields ? fields : fields.slice(0, FIRST_FIELDS)
  const c = thread.customer
  const teammates = ws.data?.teammates ?? []
  const addable = teammates.filter(
    t => !assignees.some(a => a.plain_user_id === t.plain_user_id)
  )
  const unusedLabels = (ws.data?.label_types ?? []).filter(
    lt => !refs.some(r => r.type_id === lt.id)
  )
  const StatusIcon = statusIcon(thread.status)
  const disabled = busy || !ws.data

  return (
    <div className="text-[var(--pv-ink)]">
      <Section title="Thread details">
        <div className="mb-2 font-semibold">{thread.title}</div>
        <dl>
          <Row label="Company">
            {c?.company ?? (
              <span className="text-[var(--pv-ink-3)]">No company</span>
            )}
          </Row>
          <Row label="Customer">
            {c ? (
              <span className="flex items-center gap-2">
                <PlainAvatar name={c.name} url={c.avatar_url} size={20} />{' '}
                {c.name}
              </span>
            ) : null}
          </Row>
          <Row label="Status">
            {canEdit ? (
              <span className="flex flex-col gap-1">
                <select
                  aria-label="Status"
                  className={sel}
                  disabled={disabled}
                  value={
                    thread.status === 'snoozed'
                      ? detail?.kind === 'waiting_for_customer'
                        ? 'waiting_for_customer'
                        : 'snoozed'
                      : thread.status
                  }
                  onChange={e => onStatus(e.target.value)}
                >
                  <option value="open">Needs next response</option>
                  <option value="waiting_for_customer">
                    Waiting for customer
                  </option>
                  {thread.status === 'snoozed' &&
                    detail?.kind !== 'waiting_for_customer' && (
                      <option value="snoozed">
                        {detail?.label ?? 'Snoozed'}
                      </option>
                    )}
                  <option value="snooze:1h">Snooze 1 hour</option>
                  <option value="snooze:tomorrow">
                    Snooze until tomorrow 8 am
                  </option>
                  <option value="snooze:monday">
                    Snooze until Monday 8 am
                  </option>
                  <option value="snooze:custom">Snooze until...</option>
                  <option value="done">Done</option>
                </select>
                {customUntil !== null && (
                  <span className="flex gap-1">
                    <input
                      type="datetime-local"
                      aria-label="Snooze until"
                      className={sel}
                      onChange={e => setCustomUntil(e.target.value)}
                    />
                    <button
                      type="button"
                      className={sel}
                      disabled={!customUntil}
                      onClick={() => {
                        const until = new Date(customUntil ?? '').toISOString()
                        setCustomUntil(null)
                        void act('status', { status: 'snoozed', until })
                      }}
                    >
                      Snooze
                    </button>
                  </span>
                )}
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <StatusIcon className="h-4 w-4 text-[var(--pv-accent)]" />{' '}
                {detail?.label ?? thread.status}
              </span>
            )}
          </Row>
          <Row label="Assignee">
            <div className="flex flex-col gap-1">
              {canEdit ? (
                <select
                  aria-label="Assignee"
                  className={sel}
                  disabled={disabled}
                  value={primary?.plain_user_id ?? ''}
                  onChange={e =>
                    void act('assign', {
                      plain_user_id: e.target.value || null,
                    })
                  }
                >
                  <option value="">Unassigned</option>
                  {teammates.map(t => (
                    <option key={t.plain_user_id} value={t.plain_user_id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              ) : primary ? (
                <span className="flex items-center gap-2">
                  <PlainAvatar
                    name={primary.name}
                    url={primary.avatar_url}
                    size={20}
                  />{' '}
                  {primary.name}
                </span>
              ) : (
                <span className="text-[var(--pv-ink-3)]">Unassigned</span>
              )}
              {extra.map(a => (
                <span key={a.name} className="ml-4 flex items-center gap-2">
                  <PlainAvatar name={a.name} url={a.avatar_url} size={20} />{' '}
                  {a.name}
                  {canEdit && a.plain_user_id && (
                    <button
                      type="button"
                      aria-label={`Remove assignee ${a.name}`}
                      disabled={busy}
                      onClick={() =>
                        void act('assignees', { remove: [a.plain_user_id] })
                      }
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
              {canEdit && (
                <select
                  aria-label="Add assignee"
                  className={cn(sel, 'ml-4')}
                  disabled={disabled}
                  value=""
                  onChange={e => {
                    if (e.target.value)
                      void act('assignees', { add: [e.target.value] })
                  }}
                >
                  <option value="">+ Assign</option>
                  {addable.map(t => (
                    <option key={t.plain_user_id} value={t.plain_user_id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </Row>
          <Row label="Priority">
            {canEdit ? (
              <select
                aria-label="Priority"
                className={sel}
                disabled={disabled}
                value={thread.priority}
                onChange={e =>
                  void act('priority', { priority: e.target.value })
                }
              >
                {(['urgent', 'high', 'normal', 'low'] as const).map(p => (
                  <option key={p} value={p}>
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </select>
            ) : (
              thread.priority.charAt(0).toUpperCase() + thread.priority.slice(1)
            )}
          </Row>
          <Row label="Labels">
            <span className="flex flex-wrap items-center gap-1">
              {refs.map(r => (
                <span
                  key={r.id}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--pv-border)] px-2 py-0.5"
                >
                  {r.name}
                  {canEdit && (
                    <button
                      type="button"
                      aria-label={`Remove label ${r.name}`}
                      disabled={busy}
                      onClick={() => void act('labels', { remove: [r.id] })}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
              {canEdit && (
                <select
                  aria-label="Add label"
                  className={sel}
                  disabled={disabled}
                  value=""
                  onChange={e => {
                    if (e.target.value)
                      void act('labels', { add: [e.target.value] })
                  }}
                >
                  <option value="">+</option>
                  {unusedLabels.map(lt => (
                    <option key={lt.id} value={lt.id}>
                      {lt.name}
                    </option>
                  ))}
                </select>
              )}
            </span>
          </Row>
          {thread.tier && (
            <Row label="Thread tier">
              <span className="inline-flex items-center gap-1 rounded-md border border-[var(--pv-border)] px-2 py-0.5">
                <span
                  className="h-2 w-2 rounded-sm"
                  style={{
                    background: thread.tier.color ?? 'var(--pv-accent)',
                  }}
                />
                {thread.tier.name}
              </span>
            </Row>
          )}
          {shown.map(f => (
            <Row key={f.key} label={f.label}>
              {f.value ?? (
                <span className="text-[var(--pv-ink-3)]">{f.label}</span>
              )}
            </Row>
          ))}
        </dl>
        {fields.length > FIRST_FIELDS && (
          <button
            type="button"
            className="mt-1 text-sm text-[var(--pv-ink-2)]"
            onClick={() => setMoreFields(m => !m)}
          >
            {moreFields ? 'Show fewer fields' : 'Show more fields'}
          </button>
        )}
        {busy && (
          <Loader2 className="mt-2 h-3 w-3 animate-spin text-[var(--pv-ink-3)]" />
        )}
        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      </Section>
      {c && (
        <Section title="Customer details">
          <div className="mb-2 flex items-center gap-2 font-semibold">
            <PlainAvatar name={c.name} url={c.avatar_url} /> {c.name}
          </div>
          <dl>
            <Row label="Email">{c.email}</Row>
            <Row label="External ID">
              {c.wp_profile_url ? (
                <a
                  className="text-[var(--pv-accent)] underline"
                  href={c.wp_profile_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {c.external_id}
                </a>
              ) : (
                c.external_id
              )}
            </Row>
            <Row label="Created at">
              {exact(c.created_at).split(',').slice(0, 2).join(',')}
            </Row>
            <Row label="Updated at">
              {exact(c.updated_at).split(',').slice(0, 2).join(',')}
            </Row>
          </dl>
        </Section>
      )}
      <Section title="Recent threads">
        <ul className="flex flex-col gap-1">
          {threads
            .filter(t => t.id !== thread.id)
            .map(t => {
              const Icon = statusIcon(t.status)
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-[var(--pv-surface)]"
                    onClick={() => onSelect(t)}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-[var(--pv-ink-3)]" />
                    <span className="text-[var(--pv-ink-3)]">{t.ref}</span>
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  </button>
                </li>
              )
            })}
        </ul>
      </Section>
    </div>
  )
}
