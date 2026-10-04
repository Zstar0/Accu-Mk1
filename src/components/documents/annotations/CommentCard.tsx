// src/components/documents/annotations/CommentCard.tsx
import { useState } from 'react'
import { Check, Pencil, Reply, RotateCcw, Trash2, Wand2 } from 'lucide-react'
import { CommentBody } from '@/components/flags/CommentBody'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  fetchDocumentCommentAttachmentUrl,
  type CommentLabel,
  type DocumentComment,
} from '@/lib/api-document-comments'
import { labelStyle } from './label-colors'

export interface CardActions {
  reply: (c: DocumentComment, body: string) => Promise<void>
  resolve: (c: DocumentComment) => void
  reopen: (c: DocumentComment) => void
  edit: (c: DocumentComment, body: string) => Promise<void>
  remove: (c: DocumentComment) => void
  /** Part 4: admins apply a suggestion into a draft. */
  apply?: (c: DocumentComment) => void
}
interface Props {
  c: DocumentComment
  currentRevision: number
  labels: Map<string, CommentLabel>
  lost: boolean
  selected: boolean
  canEdit: boolean
  isAdmin: boolean
  dark: boolean
  onFocus: () => void
  actions: CardActions
}

const when = (iso: string) => iso.slice(0, 16).replace('T', ' ')

export function CommentCard({
  c,
  currentRevision,
  labels,
  lost,
  selected,
  canEdit,
  isAdmin,
  dark,
  onFocus,
  actions,
}: Props) {
  const [replying, setReplying] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const label = c.label ? labels.get(c.label) : undefined
  const quote = c.anchor?.originalText ?? ''
  const elementTag = c.anchor?.htmlAnchor?.tagName
  const heading = c.anchor?.elementContext?.heading

  return (
    <article
      data-testid="comment-card"
      data-number={c.number ?? ''}
      aria-current={selected || undefined}
      className={`rounded-md border p-2 text-sm ${selected ? 'ring-2 ring-ring' : ''} ${lost ? 'opacity-80' : ''}`}
      onClick={onFocus}
    >
      <header className="mb-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {c.number != null && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 font-mono text-[11px] text-primary-foreground">
            {c.number}
          </span>
        )}
        {label && (
          <span
            className="rounded-full px-2 py-0.5"
            style={labelStyle(label.color, dark)}
          >
            {label.emoji} {label.text}
          </span>
        )}
        {c.kind === 'suggestion' && (
          <span className="rounded-full border px-2 py-0.5">Suggestion</span>
        )}
        <span className="font-medium text-foreground">{c.author}</span>
        {c.revision !== currentRevision && <span>on r{c.revision}</span>}
        <span>{when(c.created_at)}</span>
        {c.edited_at && <span>(edited)</span>}
      </header>
      {quote ? (
        <blockquote className="mb-1 border-l-2 pl-2 text-xs text-muted-foreground">
          “{quote}”
        </blockquote>
      ) : elementTag ? (
        <p className="mb-1 text-xs text-muted-foreground">
          <span className="rounded bg-muted px-1 font-mono">{elementTag}</span>
          {heading ? ` in ${heading}` : ''}
        </p>
      ) : null}
      {c.kind === 'suggestion' && (
        <p className="mb-1 rounded bg-muted/50 p-1 text-xs">
          <span className="text-muted-foreground">Replace with: </span>
          <span className="font-medium">{c.suggested_text}</span>
        </p>
      )}
      {editing ? (
        <div className="mb-1">
          <Textarea
            value={draft}
            rows={3}
            onChange={e => setDraft(e.target.value)}
          />
          <div className="mt-1 flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() =>
                void actions.edit(c, draft).then(() => setEditing(false))
              }
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        c.body && (
          <CommentBody
            body={c.body}
            mentions={[]}
            users={new Map()}
            resolveAttachmentUrl={fetchDocumentCommentAttachmentUrl}
          />
        )
      )}
      {c.replies.length > 0 && (
        <ul className="mt-1 space-y-1 border-l pl-2">
          {c.replies.map(r => (
            <li key={r.id} className="text-xs">
              <span className="font-medium">{r.author}</span>{' '}
              <span className="text-muted-foreground">
                {when(r.created_at)}
              </span>
              <CommentBody
                body={r.body}
                mentions={[]}
                users={new Map()}
                resolveAttachmentUrl={fetchDocumentCommentAttachmentUrl}
              />
            </li>
          ))}
        </ul>
      )}
      {replying && (
        <div className="mt-1">
          <Textarea
            value={draft}
            rows={2}
            placeholder="Reply…"
            onChange={e => setDraft(e.target.value)}
          />
          <div className="mt-1 flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setReplying(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!draft.trim()}
              onClick={() =>
                void actions.reply(c, draft).then(() => {
                  setReplying(false)
                  setDraft('')
                })
              }
            >
              Reply
            </Button>
          </div>
        </div>
      )}
      <footer
        className="mt-1 flex flex-wrap items-center gap-1"
        onClick={e => e.stopPropagation()}
      >
        <Button
          size="sm"
          variant="ghost"
          aria-label="Reply"
          onClick={() => {
            setDraft('')
            setReplying(v => !v)
          }}
        >
          <Reply className="h-3.5 w-3.5" />
        </Button>
        {c.status === 'open' ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label="Resolve"
            onClick={() => actions.resolve(c)}
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            aria-label="Reopen"
            onClick={() => actions.reopen(c)}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        )}
        {canEdit && (
          <>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Edit"
              onClick={() => {
                setDraft(c.body)
                setEditing(true)
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Delete"
              onClick={() => actions.remove(c)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
        {isAdmin &&
          c.kind === 'suggestion' &&
          c.status === 'open' &&
          actions.apply &&
          !lost && (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => actions.apply?.(c)}
            >
              <Wand2 className="mr-1 h-3.5 w-3.5" />
              Apply
            </Button>
          )}
      </footer>
    </article>
  )
}
