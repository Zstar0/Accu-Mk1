import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Loader2, RefreshCw } from 'lucide-react'
import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CrmError } from '@/lib/api-crm'
import {
  getCustomerSupport,
  type CustomerSupport,
  type SupportStatus,
  type SupportThread,
} from '@/lib/api-support'
import { SupportThreadPanel } from './SupportThreadPanel'

const CARD = 'rounded-lg border border-border/50 bg-card/30 p-3'
const CHIPS: { key: SupportStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'snoozed', label: 'Snoozed' },
  { key: 'done', label: 'Done' },
]
const STATUS_STYLE: Record<SupportStatus, string> = {
  open: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  snoozed: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  done: 'bg-muted text-muted-foreground',
}
const minutesSince = (iso: string) =>
  Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
const age = (iso: string) => {
  const m = minutesSince(iso)
  if (m < 60) return `${m}m`
  if (m < 48 * 60) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}
const ago = (iso: string) => {
  const m = minutesSince(iso)
  return m < 1 ? 'just now' : `${m} min ago`
}
const relative = (iso: string | null) => (iso ? `updated ${age(iso)} ago` : '')
const date = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : 'never'

export function CustomerSupportTab({ customerKey }: { customerKey: string }) {
  const [status, setStatus] = useState<SupportStatus | 'all'>('all')
  const [pages, setPages] = useState(1)
  const [refreshNonce, setRefreshNonce] = useState(0)
  // Refresh is one-shot: only the first fetch after a Refresh click asks for it.
  const sentRefresh = useRef(0)
  const [open, setOpen] = useState<SupportThread | null>(null)
  const qc = useQueryClient()
  const statuses = status === 'all' ? [] : [status]
  const takeRefresh = () => {
    const due = refreshNonce > sentRefresh.current
    sentRefresh.current = refreshNonce
    return due
  }
  const q = useQuery({
    queryKey: ['support', customerKey, statuses, pages, refreshNonce],
    queryFn: () =>
      getCustomerSupport(customerKey, {
        statuses,
        page: 1,
        refresh: takeRefresh(),
      }).then(async first => {
        if (pages <= 1) return first
        const rest = await Promise.all(
          Array.from({ length: pages - 1 }, (_, i) =>
            getCustomerSupport(customerKey, { statuses, page: i + 2 })
          )
        )
        return {
          ...first,
          threads: [first, ...rest].flatMap(r => r.threads),
        }
      }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  })

  if (q.error) {
    const e = q.error
    if (e instanceof CrmError && e.code === 'support_not_configured')
      return (
        <p className="text-sm text-muted-foreground">
          Support not configured: PLAIN_API_KEY is not set on the server.
        </p>
      )
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-red-500">Plain unavailable.</span>
        <Button variant="outline" size="sm" onClick={() => q.refetch()}>
          Retry
        </Button>
      </div>
    )
  }
  const d: CustomerSupport | undefined = q.data
  if (!d)
    return (
      <Loader2 className="mx-auto mt-8 h-5 w-5 animate-spin text-muted-foreground" />
    )
  const all = d.counts.open + d.counts.snoozed + d.counts.done

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          {all} tickets · {d.counts.open} open · {d.counts.waiting} waiting on
          us · last contact {date(d.last_contact_at)}
        </span>
        {d.oldest_waiting_since && (
          <span className="rounded-full bg-red-500/15 px-2 text-xs font-medium text-red-600 dark:text-red-400">
            Waiting on us {age(d.oldest_waiting_since)}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {CHIPS.map(c => {
          const n = c.key === 'all' ? all : d.counts[c.key]
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={status === c.key}
              onClick={() => {
                setStatus(c.key)
                setPages(1)
              }}
              className={cn(
                'rounded-full border px-3 py-0.5 text-xs font-medium',
                status === c.key
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {c.label} {n}
            </button>
          )
        })}
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {d.stale ? (
            <span className="text-amber-500">
              Plain is unavailable, showing data from {ago(d.fetched_at)}
            </span>
          ) : (
            <span>Updated {ago(d.fetched_at)}</span>
          )}
          {d.refresh_throttled && <span>(refreshed moments ago)</span>}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRefreshNonce(n => n + 1)
              void qc.invalidateQueries({
                queryKey: ['support', 'thread', customerKey],
              })
            }}
            disabled={q.isFetching}
          >
            <RefreshCw
              className={cn('mr-1 h-3 w-3', q.isFetching && 'animate-spin')}
            />
            Refresh
          </Button>
        </div>
      </div>

      <section className={CARD}>
        {d.threads.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {all === 0
              ? 'No support tickets for this customer.'
              : 'No tickets with this status.'}
          </p>
        )}
        {d.threads.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setOpen(t)}
            className="flex w-full flex-col gap-0.5 rounded px-1 py-1.5 text-left hover:bg-muted/30"
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t.ref}</span>
              <span className="font-medium">{t.title}</span>
              <span
                className={cn(
                  'rounded-full px-2 text-[10px] capitalize',
                  STATUS_STYLE[t.status]
                )}
              >
                {t.status}
              </span>
              {(t.priority === 'urgent' || t.priority === 'high') && (
                <span className="rounded-full bg-red-500/15 px-2 text-[10px] text-red-600 dark:text-red-400">
                  {t.priority === 'urgent' ? 'Urgent' : 'High'}
                </span>
              )}
              {t.labels.map(l => (
                <span
                  key={l}
                  className="rounded-full bg-muted px-2 text-[10px] text-muted-foreground"
                >
                  {l}
                </span>
              ))}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {t.assignee ?? 'Unassigned'} · {relative(t.updated_at)}
              {t.preview ? ` · ${t.preview}` : ''}
            </span>
          </button>
        ))}
        {d.threads.length < d.total && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPages(p => p + 1)}
          >
            Load more
          </Button>
        )}
      </section>

      <SupportThreadPanel
        customerKey={customerKey}
        thread={open}
        onClose={() => setOpen(null)}
      />
    </div>
  )
}
