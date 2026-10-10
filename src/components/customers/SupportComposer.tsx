import { useEffect, useState, type KeyboardEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { renderCommentHtml } from '@/components/flags/comment-markdown'
import type { SupportStatus } from '@/lib/api-support'
import { supportErrorMessage } from './support-errors'

type Tab = 'reply' | 'note'
const MAX = 10_000
const draftKey = (threadId: string, tab: Tab) =>
  `mk1.supportDraft.${threadId}.${tab}`

function readDraft(threadId: string, tab: Tab): string {
  try {
    return localStorage.getItem(draftKey(threadId, tab)) ?? ''
  } catch {
    return ''
  }
}

function writeDraft(threadId: string, tab: Tab, text: string) {
  try {
    if (text) localStorage.setItem(draftKey(threadId, tab), text)
    else localStorage.removeItem(draftKey(threadId, tab))
  } catch {
    // storage blocked: drafts just won't persist
  }
}

/** Reply to the customer (impersonated) or add an internal note. */
export function SupportComposer({
  threadId,
  threadStatus,
  sendAs,
  onSubmit,
}: {
  threadId: string
  threadStatus: SupportStatus
  sendAs: string
  onSubmit: (tab: Tab, markdown: string) => Promise<void>
}) {
  const [tab, setTab] = useState<Tab>('reply')
  const [text, setText] = useState(() => readDraft(threadId, 'reply'))
  const [preview, setPreview] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmedOnce, setConfirmedOnce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setText(readDraft(threadId, tab))
    setConfirming(false)
    setError(null)
  }, [threadId, tab])

  const update = (v: string) => {
    setText(v)
    writeDraft(threadId, tab, v)
  }
  const empty = text.trim().length === 0 || text.trim().length > MAX

  const send = async () => {
    if (empty || busy) return
    if (tab === 'reply' && !confirmedOnce && !confirming) {
      setConfirming(true)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(tab, text.trim())
      setConfirmedOnce(true)
      setConfirming(false)
      update('')
    } catch (e) {
      setError(supportErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void send()
    }
  }

  const label = tab === 'reply' ? 'Reply' : 'Note'
  return (
    <div className="sticky bottom-0 border-t bg-background p-3">
      <div role="tablist" className="mb-2 flex gap-1 text-xs">
        {(['reply', 'note'] as const).map(t => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              'rounded-md px-2 py-1',
              tab === t ? 'bg-accent font-medium' : 'text-muted-foreground'
            )}
          >
            {t === 'reply' ? 'Reply' : 'Note'}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPreview(p => !p)}
          className="ml-auto rounded-md px-2 py-1 text-muted-foreground"
        >
          {preview ? 'Edit' : 'Preview'}
        </button>
      </div>
      {preview ? (
        <div
          className="min-h-24 rounded-md border p-2 text-sm [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-4"
          // Sanitised by renderCommentHtml (markdown-it html:false + DOMPurify).
          dangerouslySetInnerHTML={{ __html: renderCommentHtml(text, []) }}
        />
      ) : (
        <textarea
          aria-label={label}
          value={text}
          onChange={e => update(e.target.value)}
          onKeyDown={onKey}
          rows={4}
          className={cn(
            'w-full resize-y rounded-md border p-2 text-sm',
            tab === 'note' && 'border-amber-500/40 bg-amber-500/10'
          )}
          placeholder={
            tab === 'reply'
              ? 'Write to the customer. Markdown works.'
              : 'Internal note, only the team sees this.'
          }
        />
      )}
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      <div className="mt-2 flex items-center gap-2">
        {confirming ? (
          <>
            <span className="text-xs">Send this reply to the customer?</span>
            <Button size="sm" onClick={() => void send()} disabled={busy}>
              {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Yes, send
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            onClick={() => void send()}
            disabled={empty || busy}
          >
            {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            {tab === 'reply' ? `Send as ${sendAs}` : 'Add internal note'}
          </Button>
        )}
        {tab === 'reply' && threadStatus !== 'open' && (
          <span className="text-xs text-muted-foreground">
            Replying moves this ticket back to Todo.
          </span>
        )}
      </div>
    </div>
  )
}
