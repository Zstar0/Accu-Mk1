import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, X } from 'lucide-react'
import {
  getSupportWorkspace,
  type SupportAction,
  type SupportThread,
} from '@/lib/api-support'
import { supportErrorMessage } from './support-errors'

type Run = (
  action: SupportAction,
  body: Record<string, unknown>
) => Promise<void>

function at8(daysAhead: number, weekday?: number): string {
  const d = new Date()
  if (weekday !== undefined) {
    const delta = (weekday - d.getDay() + 7) % 7 || 7
    d.setDate(d.getDate() + delta)
  } else d.setDate(d.getDate() + daysAhead)
  d.setHours(8, 0, 0, 0)
  return d.toISOString()
}

const SNOOZE: Record<string, () => string> = {
  'snooze:1h': () => new Date(Date.now() + 3600_000).toISOString(),
  'snooze:tomorrow': () => at8(1),
  'snooze:monday': () => at8(0, 1),
}

const sel = 'rounded-md border bg-background px-2 py-1 text-xs'

/** Status, snooze, assignee, priority and labels for one ticket. Each applies immediately. */
export function SupportThreadControls({
  thread,
  run,
}: {
  thread: SupportThread
  run: Run
}) {
  const ws = useQuery({
    queryKey: ['support', 'workspace'],
    queryFn: getSupportWorkspace,
    staleTime: 600_000,
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [customUntil, setCustomUntil] = useState('')

  const act = async (
    key: string,
    action: SupportAction,
    body: Record<string, unknown>
  ) => {
    setBusy(key)
    setError(null)
    try {
      await run(action, body)
    } catch (e) {
      setError(supportErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const onStatus = (v: string) => {
    if (v === 'open') return void act('status', 'status', { status: 'todo' })
    if (v === 'done') return void act('status', 'status', { status: 'done' })
    const preset = SNOOZE[v]
    if (preset)
      return void act('status', 'status', {
        status: 'snoozed',
        until: preset(),
      })
    if (v === 'snooze:custom') setCustomUntil(' ')
  }

  const refs = thread.label_refs ?? []
  const unused = (ws.data?.label_types ?? []).filter(
    lt => !refs.some(r => r.type_id === lt.id)
  )
  return (
    <div className="flex flex-col gap-2 border-b px-4 pb-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          Status
          <select
            aria-label="Status"
            className={sel}
            value={thread.status === 'snoozed' ? 'snoozed' : thread.status}
            onChange={e => onStatus(e.target.value)}
            disabled={busy !== null}
          >
            <option value="open">Todo</option>
            <option value="done">Done</option>
            {thread.status === 'snoozed' && (
              <option value="snoozed">Snoozed</option>
            )}
            <option value="snooze:1h">Snooze 1 hour</option>
            <option value="snooze:tomorrow">Snooze until tomorrow 8 am</option>
            <option value="snooze:monday">Snooze until Monday 8 am</option>
            <option value="snooze:custom">Snooze until...</option>
          </select>
        </label>
        {customUntil && (
          <span className="flex items-center gap-1">
            <input
              type="datetime-local"
              aria-label="Snooze until"
              className={sel}
              onChange={e => setCustomUntil(e.target.value)}
            />
            <button
              type="button"
              className={sel}
              disabled={customUntil.trim() === ''}
              onClick={() => {
                const until = new Date(customUntil).toISOString()
                setCustomUntil('')
                void act('status', 'status', { status: 'snoozed', until })
              }}
            >
              Snooze
            </button>
          </span>
        )}
        <label className="flex items-center gap-1">
          Priority
          <select
            aria-label="Priority"
            className={sel}
            value={thread.priority}
            onChange={e =>
              void act('priority', 'priority', { priority: e.target.value })
            }
            disabled={busy !== null}
          >
            {(['urgent', 'high', 'normal', 'low'] as const).map(p => (
              <option key={p} value={p}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Assignee
          <select
            aria-label="Assignee"
            className={sel}
            value={thread.assignee_id ?? ''}
            onChange={e =>
              void act('assign', 'assign', {
                plain_user_id: e.target.value || null,
              })
            }
            disabled={busy !== null || !ws.data}
          >
            <option value="">Unassigned</option>
            {ws.data?.teammates.map(t => (
              <option key={t.plain_user_id} value={t.plain_user_id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {busy && (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {refs.map(r => (
          <span
            key={r.id}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5"
          >
            {r.name}
            <button
              type="button"
              aria-label={`Remove label ${r.name}`}
              onClick={() => void act('labels', 'labels', { remove: [r.id] })}
              disabled={busy !== null}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <select
          aria-label="Add label"
          className={sel}
          value=""
          onChange={e => {
            if (e.target.value)
              void act('labels', 'labels', { add: [e.target.value] })
          }}
          disabled={busy !== null || !ws.data}
        >
          <option value="">+ Label</option>
          {unused.map(lt => (
            <option key={lt.id} value={lt.id}>
              {lt.name}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="text-red-500">{error}</p>}
    </div>
  )
}
