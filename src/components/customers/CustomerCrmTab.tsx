import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Loader2,
  Mail,
  MessageSquare,
  Phone,
  RefreshCw,
  StickyNote,
  Users,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  CrmError,
  getCustomerCrm,
  type CrmItem,
  type CrmItemType,
  type CustomerCrm,
} from '@/lib/api-crm'
import { CrmActivityPanel } from './CrmActivityPanel'

const CARD = 'rounded-lg border border-border/50 bg-card/30 p-3'
const CHIPS: { key: CrmItemType | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'email', label: 'Emails' },
  { key: 'call', label: 'Calls' },
  { key: 'sms', label: 'SMS' },
  { key: 'meeting', label: 'Meetings' },
  { key: 'note', label: 'Notes' },
]
const ICON = {
  email: Mail,
  call: Phone,
  sms: MessageSquare,
  meeting: Users,
  note: StickyNote,
}
const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`
const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : 'Undated'
const time = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      })
    : ''
const ago = (iso: string) => {
  const m = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  )
  return m < 1 ? 'just now' : `${m} min ago`
}

export function CustomerCrmTab({ customerKey }: { customerKey: string }) {
  const [type, setType] = useState<CrmItemType | 'all'>('all')
  const [includeAutomated, setIncludeAutomated] = useState(false)
  const [pages, setPages] = useState(1)
  const [refreshNonce, setRefreshNonce] = useState(0)
  // Refresh is one-shot: only the first fetch after a Refresh click asks for it.
  const sentRefresh = useRef(0)
  const [open, setOpen] = useState<CrmItem | null>(null)
  const qc = useQueryClient()
  const types = type === 'all' ? [] : [type]
  const takeRefresh = () => {
    const due = refreshNonce > sentRefresh.current
    sentRefresh.current = refreshNonce
    return due
  }
  const q = useQuery({
    queryKey: [
      'crm',
      customerKey,
      types,
      includeAutomated,
      pages,
      refreshNonce,
    ],
    queryFn: () =>
      getCustomerCrm(customerKey, {
        types,
        includeAutomated,
        page: 1,
        refresh: takeRefresh(),
      }).then(async first => {
        if (pages <= 1) return first
        const rest = await Promise.all(
          Array.from({ length: pages - 1 }, (_, i) =>
            getCustomerCrm(customerKey, {
              types,
              includeAutomated,
              page: i + 2,
            })
          )
        )
        return { ...first, items: [first, ...rest].flatMap(r => r.items) }
      }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  })

  if (q.error) {
    const e = q.error
    if (e instanceof CrmError && e.code === 'crm_not_configured')
      return (
        <p className="text-sm text-muted-foreground">
          CRM not configured: CLOSE_API_KEY is not set on the server.
        </p>
      )
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-red-500">Close is unreachable.</span>
        <Button variant="outline" size="sm" onClick={() => q.refetch()}>
          Retry
        </Button>
      </div>
    )
  }
  const d: CustomerCrm | undefined = q.data
  if (!d)
    return (
      <Loader2 className="mx-auto mt-8 h-5 w-5 animate-spin text-muted-foreground" />
    )
  if (d.leads.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No Close lead found for{' '}
        {d.emails_tried.length
          ? d.emails_tried.join(', ')
          : 'this customer (no email on file)'}
        .
      </p>
    )

  const groups: [string, CrmItem[]][] = []
  for (const it of d.items) {
    const k = day(it.at)
    const g = groups.find(([gk]) => gk === k)
    if (g) g[1].push(it)
    else groups.push([k, [it]])
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 lg:grid-cols-2">
        {d.leads.map(l => (
          <section key={l.id} className={CARD}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium">{l.name}</h3>
              <a
                className="text-xs text-sky-500 hover:underline"
                href={l.url}
                target="_blank"
                rel="noreferrer"
              >
                Open in Close
              </a>
            </div>
            <div className="mt-1 flex flex-wrap gap-2 text-xs">
              {l.status && (
                <span className="rounded-full bg-emerald-500/15 px-2 text-emerald-700 dark:text-emerald-300">
                  {l.status}
                </span>
              )}
              {l.owner && (
                <span className="text-muted-foreground">Owner: {l.owner}</span>
              )}
            </div>
            {l.contacts.map(c => (
              <div
                key={c.name + c.emails.join()}
                className="mt-2 text-xs text-muted-foreground"
              >
                <span className="text-foreground">{c.name || 'Contact'}</span>{' '}
                {c.emails.join(', ')} {c.phones.join(', ')}
              </div>
            ))}
            {l.opportunities.map((o, i) => (
              <div key={i} className="mt-1 text-xs">
                {o.status} · {money(o.value)}
                {o.value_period && o.value_period !== 'one_time'
                  ? ` / ${o.value_period}`
                  : ''}
                {o.expected_date ? ` · expected ${o.expected_date}` : ''}
              </div>
            ))}
          </section>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {CHIPS.map(c => {
          const n = c.key === 'all' ? null : d.counts[c.key]
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={type === c.key}
              onClick={() => {
                setType(c.key)
                setPages(1)
              }}
              className={cn(
                'rounded-full border px-3 py-0.5 text-xs font-medium',
                type === c.key
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {c.label}
              {n !== null ? ` ${n}` : ''}
            </button>
          )
        })}
        <label className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            aria-label="Show automated"
            checked={includeAutomated}
            onCheckedChange={v => {
              setIncludeAutomated(v)
              setPages(1)
            }}
          />
          Show automated ({d.counts.automated})
        </label>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {d.stale && (
            <span className="text-amber-500">
              Showing data from {ago(d.fetched_at)}
            </span>
          )}
          {!d.stale && <span>Updated {ago(d.fetched_at)}</span>}
          {d.refresh_throttled && <span>(refreshed moments ago)</span>}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRefreshNonce(n => n + 1)
              void qc.invalidateQueries({
                queryKey: ['crm', 'activity', customerKey],
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
        {d.items.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No activity of this type.
          </p>
        )}
        {groups.map(([label, items]) => (
          <div key={label} className="mb-3">
            <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
              {label}
            </div>
            {items.map(it => {
              const Icon = ICON[it.type]
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => setOpen(it)}
                  className="flex w-full items-start gap-2 rounded px-1 py-1.5 text-left hover:bg-muted/30"
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  {it.direction === 'inbound' && (
                    <ArrowDownLeft className="mt-0.5 h-3 w-3 text-sky-500" />
                  )}
                  {it.direction === 'outbound' && (
                    <ArrowUpRight className="mt-0.5 h-3 w-3 text-emerald-500" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{it.title}</span>
                    {it.support_thread_url && (
                      <span className="ml-2 rounded-full bg-violet-500/15 px-2 text-[10px] text-violet-500">
                        Support thread
                      </span>
                    )}
                    <span className="block truncate text-xs text-muted-foreground">
                      {it.who}
                      {it.preview ? ` · ${it.preview}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {time(it.at)}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
        {d.items.length < d.total && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPages(p => p + 1)}
          >
            Load more
          </Button>
        )}
      </section>

      <CrmActivityPanel
        customerKey={customerKey}
        item={open}
        onClose={() => setOpen(null)}
      />
    </div>
  )
}
