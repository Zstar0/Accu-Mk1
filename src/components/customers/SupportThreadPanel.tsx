import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDownUp, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
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
      throw e
    }
    if (out.detail) qc.setQueryData(key, out.detail)
    else void qc.invalidateQueries({ queryKey: key })
    void qc.invalidateQueries({ queryKey: ['support', customerKey] })
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
  const scroller = useRef<HTMLDivElement>(null)
  const loadedId = d?.thread.id
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
  const onMore = (action: string, until?: string) =>
    void run(
      'status',
      action === 'todo'
        ? { status: 'todo' }
        : until
          ? { status: 'snoozed', until }
          : { status: action }
    ).catch(() => {
      // the sidebar shows status errors; the bar has no error line of its own
    })

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
            <span>{current?.status_detail?.label ?? current?.status}</span>
            <span>· {current?.priority}</span>
            {current && (
              <a
                className="text-[var(--pv-accent)] hover:underline"
                href={current.plain_url}
                target="_blank"
                rel="noreferrer"
              >
                Open in Plain
              </a>
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
            {current && (
              <TicketSidebar
                thread={current}
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
              className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
            >
              {q.isLoading && (
                <Loader2 className="mx-auto mt-6 h-5 w-5 animate-spin text-[var(--pv-ink-3)]" />
              )}
              {q.isError && (
                <p className="mt-4 text-sm text-red-500">
                  Could not load this conversation.
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
                onSubmit={(tab, markdown) => run(tab, { markdown })}
              />
            )}
            {current && hasSeat && (
              <TicketActionBar
                customerFirstName={first}
                onOpen={setComposer}
                onMore={onMore}
              />
            )}
            {seat.data && !hasSeat && (
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
