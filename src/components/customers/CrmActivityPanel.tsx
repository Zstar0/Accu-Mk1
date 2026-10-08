import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { getCrmActivity, type CrmItem } from '@/lib/api-crm'

const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : ''

/** Full CRM item. Bodies are plain text (whitespace-pre-wrap), never HTML. */
export function CrmActivityPanel({
  customerKey,
  item,
  onClose,
}: {
  customerKey: string
  item: CrmItem | null
  onClose: () => void
}) {
  const q = useQuery({
    queryKey: ['crm', 'activity', customerKey, item?.id],
    queryFn: () =>
      item
        ? getCrmActivity(customerKey, item.id, item.type)
        : Promise.reject(new Error('no item')),
    enabled: item !== null,
    staleTime: 300_000,
  })
  const d = q.data
  return (
    <Sheet open={item !== null} onOpenChange={o => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{item?.title}</SheetTitle>
          <SheetDescription>
            {item?.lead_name} · {when(item?.at)}{' '}
            {item?.who ? `· ${item.who}` : ''}
          </SheetDescription>
        </SheetHeader>
        {q.isLoading && (
          <Loader2 className="mx-auto mt-6 h-5 w-5 animate-spin text-muted-foreground" />
        )}
        {q.isError && (
          <p className="mt-4 text-sm text-red-500">Could not load this item.</p>
        )}
        {d && (
          <div className="mt-4 flex flex-col gap-4 px-4 text-sm">
            {d.messages?.map(m => (
              <div
                key={m.id}
                className="rounded-md border border-border/50 p-3"
              >
                <div className="mb-2 text-xs text-muted-foreground">
                  {m.direction === 'inbound' ? 'From' : 'Sent by'} {m.sender} ·
                  to {m.to.join(', ')}
                  {m.cc.length > 0 && ` · cc ${m.cc.join(', ')}`} · {when(m.at)}
                </div>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
              </div>
            ))}
            {d.type === 'call' && (
              <div className="flex flex-col gap-1">
                <div>
                  {d.direction === 'inbound' ? 'Inbound' : 'Outbound'} call
                  {d.duration
                    ? `, ${Math.max(1, Math.round(d.duration / 60))} min`
                    : ''}
                  {d.disposition ? `, ${d.disposition}` : ''}
                </div>
                {d.note && <p className="whitespace-pre-wrap">{d.note}</p>}
                {d.recording_url && (
                  <a
                    className="text-sky-500 hover:underline"
                    href={d.recording_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Recording
                  </a>
                )}
              </div>
            )}
            {d.type === 'sms' && (
              <p className="whitespace-pre-wrap">{d.text}</p>
            )}
            {d.type === 'meeting' && (
              <div className="flex flex-col gap-1">
                <div>
                  {when(d.starts_at)}
                  {d.ends_at ? ` to ${when(d.ends_at)}` : ''}
                </div>
                {d.attendees && d.attendees.length > 0 && (
                  <div>Attendees: {d.attendees.join(', ')}</div>
                )}
                {d.note && <p className="whitespace-pre-wrap">{d.note}</p>}
              </div>
            )}
            {d.type === 'note' &&
              (d.support_thread_url ? (
                <a
                  className="text-sky-500 hover:underline"
                  href={d.support_thread_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open support thread in Plain
                </a>
              ) : (
                <p className="whitespace-pre-wrap">{d.note}</p>
              ))}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
