import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { getSupportThread, type SupportThread } from '@/lib/api-support'

const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : ''

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
  return (
    <Sheet open={thread !== null} onOpenChange={o => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
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
          <div className="mt-4 flex flex-col gap-3 px-4 text-sm">
            {d.entries.map(e =>
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
      </SheetContent>
    </Sheet>
  )
}
