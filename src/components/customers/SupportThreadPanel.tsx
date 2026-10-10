import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDownUp, Loader2 } from 'lucide-react'
import { useState } from 'react'
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
import { SupportThreadControls } from './SupportThreadControls'
import { useSupportSeat } from './useSupportSeat'

const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : ''

const ORDER_KEY = 'mk1.supportConversationOrder'
type Order = 'newest' | 'oldest'

function readOrder(): Order {
  try {
    return localStorage.getItem(ORDER_KEY) === 'oldest' ? 'oldest' : 'newest'
  } catch {
    return 'newest'
  }
}

/** Full Plain conversation. Bodies are plain text (whitespace-pre-wrap), never HTML. */
export function SupportThreadPanel({
  customerKey,
  thread,
  onClose,
}: {
  customerKey: string
  thread: SupportThread | null
  onClose: () => void
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
    const out = await supportAction(customerKey, thread.id, action, body)
    const key = ['support', 'thread', customerKey, thread.id]
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
  const entries = d
    ? order === 'newest'
      ? [...d.entries].reverse()
      : d.entries
    : []
  return (
    <Sheet open={thread !== null} onOpenChange={o => !o && onClose()}>
      <ResizableSheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            {thread?.ref} · {thread?.title}
          </SheetTitle>
          <SheetDescription>
            {thread?.status}
            {thread?.labels.length ? ` · ${thread.labels.join(', ')}` : ''}
            {' · '}
            {thread && (
              <a
                className="text-sky-500 hover:underline"
                href={thread.plain_url}
                target="_blank"
                rel="noreferrer"
              >
                Open in Plain
              </a>
            )}
          </SheetDescription>
        </SheetHeader>
        {current && hasSeat && (
          <SupportThreadControls thread={current} run={run} />
        )}
        {seat.data && !hasSeat && (
          <p className="px-4 text-xs text-muted-foreground">
            Replying needs a Plain account under your Mk1 email.
          </p>
        )}
        {q.isLoading && (
          <Loader2 className="mx-auto mt-6 h-5 w-5 animate-spin text-muted-foreground" />
        )}
        {q.isError && (
          <p className="mt-4 px-4 text-sm text-red-500">
            Could not load this conversation.
          </p>
        )}
        {d?.stale && (
          <p className="mt-2 px-4 text-xs text-amber-500">
            Plain is unavailable, showing a saved copy.
          </p>
        )}
        {d && (
          <div className="px-4">
            <button
              type="button"
              onClick={toggleOrder}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
            >
              <ArrowDownUp className="h-3 w-3" />
              {order === 'newest' ? 'Newest first' : 'Oldest first'}
            </button>
          </div>
        )}
        {d && (
          <div className="flex flex flex-col gap-3 px-4 text-sm">
            {entries.map(e =>
              e.kind === 'event' ? (
                <div
                  key={e.id}
                  className="text-center text-xs text-muted-foreground"
                >
                  {e.text} · {when(e.at)}
                </div>
              ) : (
                <div
                  key={e.id}
                  data-internal={e.internal ? 'true' : 'false'}
                  className={cn(
                    'rounded-md border p-3',
                    e.internal
                      ? 'border-amber-500/40 bg-amber-500/10'
                      : 'border-border/50'
                  )}
                >
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    {e.internal && (
                      <span className="rounded-full bg-amber-500/20 px-2 font-medium text-amber-700 dark:text-amber-300">
                        Internal
                      </span>
                    )}
                    <span className="text-foreground">
                      {e.author ??
                        (e.author_kind === 'customer' ? 'Customer' : 'Team')}
                    </span>
                    <span>{when(e.at)}</span>
                  </div>
                  {e.subject && (
                    <div className="mb-1 font-medium">{e.subject}</div>
                  )}
                  <p className="whitespace-pre-wrap break-words">{e.text}</p>
                </div>
              )
            )}
          </div>
        )}
        {current && hasSeat && (
          <SupportComposer
            threadId={current.id}
            threadStatus={current.status}
            sendAs={seat.data?.name ?? 'you'}
            onSubmit={(tab, markdown) => run(tab, { markdown })}
          />
        )}
      </ResizableSheetContent>
    </Sheet>
  )
}
