import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDownUp, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { CrmError } from '@/lib/api-crm'
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { EntityFlagButton } from '@/components/flags/EntityFlagButton'
import { ResizableSheetContent } from './ResizableSheetContent'
import {
  getSupportThread,
  supportAction,
  type SupportAction,
  type SupportThread,
} from '@/lib/api-support'
import { SupportComposer } from './SupportComposer'
import { TicketActionBar } from './TicketActionBar'
import { TicketSidebar } from './TicketSidebar'
import { TicketTimeline } from './TicketTimeline'
import { useSupportSeat } from './useSupportSeat'
import { statusLabel } from './plain-time'
import { supportErrorMessage } from './support-errors'
import './plain-view.css'

const ORDER_KEY = 'mk1.supportConversationOrder'
type Order = 'newest' | 'oldest'

function readOrder(): Order {
  try {
    return localStorage.getItem(ORDER_KEY) === 'newest' ? 'newest' : 'oldest'
  } catch {
    return 'oldest'
  }
}

/** A Plain ticket in Plain's layout: conversation + action bar on the left, details sidebar on the right. */
export function SupportThreadPanel({
  customerKey,
  thread,
  onClose,
  threads,
  onSelect,
}: {
  customerKey: string
  thread: SupportThread | null
  onClose: () => void
  threads?: SupportThread[]
  onSelect?: (t: SupportThread) => void
}) {
  const q = useQuery({
    queryKey: ['support', 'thread', customerKey, thread?.id],
    queryFn: () =>
      thread
        ? getSupportThread(customerKey, thread.id, { refresh: false })
        : Promise.reject(new Error('no thread')),
    enabled: thread !== null,
    staleTime: 300_000,
  })
  const d = q.data
  const qc = useQueryClient()
  const seat = useSupportSeat()
  const hasSeat = seat.data?.has_seat === true
  const current = d?.thread ?? thread
  // A flag link opens with a placeholder row (no plain_url); show nothing from it until the detail loads.
  const known = d?.thread ?? (thread?.plain_url ? thread : null)
  const noAccess = q.error instanceof CrmError && q.error.status === 403
  const run = async (action: SupportAction, body: Record<string, unknown>) => {
    if (!thread) return
    const key = ['support', 'thread', customerKey, thread.id]
    let out
    try {
      out = await supportAction(customerKey, thread.id, action, body)
    } catch (e) {
      // The write may have happened (or half-happened): show Plain's current state, then report.
      void qc.invalidateQueries({ queryKey: key })
      void qc.invalidateQueries({ queryKey: ['support', customerKey] })
      void qc.invalidateQueries({ queryKey: ['customers', 'touchpoints'] })
      throw e
    }
    if (out.detail) qc.setQueryData(key, out.detail)
    else void qc.invalidateQueries({ queryKey: key })
    void qc.invalidateQueries({ queryKey: ['support', customerKey] })
    // The Insights "Last support" cells summarise these threads.
    void qc.invalidateQueries({ queryKey: ['customers', 'touchpoints'] })
  }
  const [order, setOrder] = useState<Order>(readOrder)
  const toggleOrder = () => {
    const next = order === 'newest' ? 'oldest' : 'newest'
    setOrder(next)
    try {
      localStorage.setItem(ORDER_KEY, next)
    } catch {
      // storage blocked: choice just won't persist
    }
  }
  const [composer, setComposer] = useState<'reply' | 'note' | null>(null)
  const [details, setDetails] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const loadedId = d?.thread.id
  // Set when the viewer sends; the next growth of the conversation scrolls to their new message.
  const pendingScroll = useRef(false)
  const entryCount = d?.entries.length ?? 0
  useEffect(() => {
    const el = scroller.current
    if (!el || !pendingScroll.current) return
    pendingScroll.current = false
    el.scrollTop = order === 'oldest' ? el.scrollHeight : 0
  }, [entryCount, order])
  useEffect(() => {
    const el = scroller.current
    if (el && order === 'oldest') el.scrollTop = el.scrollHeight
  }, [loadedId, order])

  const entries = d
    ? order === 'newest'
      ? [...d.entries].reverse()
      : d.entries
    : []
  const first =
    (current?.customer?.name ?? 'customer').split(' ')[0] ?? 'customer'
  const onMore = (action: string, until?: string) => {
    setMoreError(null)
    run(
      'status',
      action === 'todo'
        ? { status: 'todo' }
        : until
          ? { status: 'snoozed', until }
          : { status: action }
    ).catch((e: unknown) => setMoreError(supportErrorMessage(e)))
  }

  return (
    <Sheet open={thread !== null} onOpenChange={o => !o && onClose()}>
      <ResizableSheetContent
        widthKey="mk1.supportSlideoutWidth"
        defaultWidth={1100}
        className="plain-view @container flex flex-col gap-0 overflow-hidden p-0"
        onOpenAutoFocus={e => {
          // Focus the sheet itself, not its first control (a sidebar select), so R and N work at once.
          e.preventDefault()
          if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus()
        }}
        onEscapeKeyDown={e => {
          // Esc closes the composer first (draft kept); only a second Esc closes the slide-out.
          if (composer) {
            e.preventDefault()
            setComposer(null)
          }
        }}
      >
        <SheetHeader className="border-b border-[var(--pv-border)] px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-[var(--pv-ink)]">
            <span className="text-[var(--pv-ink-3)]">{current?.ref}</span>{' '}
            {current?.title}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-2 text-[var(--pv-ink-2)]">
            {known && (
              <>
                <span>{statusLabel(known.status_detail) ?? known.status}</span>
                <span>· {known.priority}</span>
              </>
            )}
            {known && (
              <a
                className="text-[var(--pv-accent)] hover:underline"
                href={known.plain_url}
                target="_blank"
                rel="noreferrer"
              >
                Open in Plain
              </a>
            )}
            {current && (
              <EntityFlagButton
                entityType="support_ticket"
                entityId={`${customerKey}|${current.id}`}
              />
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col @min-[820px]:flex-row">
          <button
            type="button"
            className="border-b border-[var(--pv-border)] px-4 py-2 text-left text-sm @min-[820px]:hidden"
            onClick={() => setDetails(v => !v)}
          >
            {details ? 'Hide details' : 'Details'}
          </button>
          <aside
            className={cn(
              'overflow-y-auto border-[var(--pv-border)] @min-[820px]:order-2 @min-[820px]:block @min-[820px]:w-[300px] @min-[820px]:shrink-0 @min-[820px]:border-l',
              details ? 'block border-b' : 'hidden'
            )}
          >
            {known && (
              <TicketSidebar
                thread={known}
                threads={threads ?? []}
                canEdit={hasSeat}
                run={run}
                onSelect={t => {
                  setComposer(null)
                  onSelect?.(t)
                }}
              />
            )}
          </aside>
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div
              ref={scroller}
              data-testid="ticket-scroller"
              className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
            >
              {q.isLoading && (
                <Loader2 className="mx-auto mt-6 h-5 w-5 animate-spin text-[var(--pv-ink-3)]" />
              )}
              {q.isError && (
                <p className="mt-4 text-sm text-red-500">
                  {noAccess
                    ? "You don't have access to this ticket. Ask to be added to a flag about it."
                    : 'Could not load this conversation.'}
                </p>
              )}
              {d?.via_flag != null && (
                <p className="mb-2 rounded-md border border-[var(--pv-border)] bg-[var(--pv-surface)] px-3 py-2 text-xs text-[var(--pv-ink-2)]">
                  {`You're seeing this ticket because you're on flag #${d.via_flag}.`}
                </p>
              )}
              {d?.stale && (
                <p className="mb-2 text-xs text-amber-500">
                  Plain is unavailable, showing a saved copy.
                </p>
              )}
              {d && (
                <div className="mb-3">
                  <button
                    type="button"
                    onClick={toggleOrder}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--pv-border)] px-2 py-1 text-xs text-[var(--pv-ink-2)] hover:bg-[var(--pv-surface)]"
                  >
                    <ArrowDownUp className="h-3 w-3" />
                    {order === 'newest' ? 'Newest first' : 'Oldest first'}
                  </button>
                </div>
              )}
              {d && (
                <TicketTimeline
                  entries={entries}
                  customerFirstName={first}
                  viewerName={seat.data?.name ?? ''}
                />
              )}
            </div>
            {current && hasSeat && composer && (
              <SupportComposer
                key={composer}
                threadId={current.id}
                threadStatus={current.status}
                sendAs={seat.data?.name ?? 'you'}
                initialTab={composer}
                onClose={() => setComposer(null)}
                onSubmit={async (tab, markdown) => {
                  pendingScroll.current = true
                  try {
                    await run(tab, { markdown })
                  } catch (e) {
                    pendingScroll.current = false
                    throw e
                  }
                }}
              />
            )}
            {moreError && (
              <p className="px-4 text-xs text-red-500">{moreError}</p>
            )}
            {current && hasSeat && (
              <TicketActionBar
                customerFirstName={first}
                onOpen={setComposer}
                onMore={onMore}
              />
            )}
            {seat.data && !hasSeat && d?.via_flag == null && (
              <p className="px-4 pb-3 text-xs text-[var(--pv-ink-3)]">
                Replying needs a Plain account under your Mk1 email.
              </p>
            )}
          </section>
        </div>
      </ResizableSheetContent>
    </Sheet>
  )
}
