import { useEffect, useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import type { CommentLabel } from '@/lib/api-document-comments'
import { ImageAnnotator } from '@/vendor/plannotator/image-annotator'
import type { Rect } from './bridge-messages'

export const MAX_QUOTE = 400

export type ComposerMode = 'comment' | 'suggestion' | 'global'
export interface ComposerSubmit {
  body: string
  suggested_text?: string
  label?: string | null
}
interface Props {
  open: boolean
  /** Null for a global comment: the composer docks top-right of the container. */
  rect: Rect | null
  mode: ComposerMode
  quote: string
  labels: CommentLabel[]
  initialLabel?: CommentLabel | null
  onSubmit: (v: ComposerSubmit) => Promise<void>
  onCancel: () => void
  /** Uploads and returns the attachment id. */
  uploadImage: (blob: Blob, name: string) => Promise<number>
}

/** The comment / suggestion / global composer (spec §8). */
export function CommentComposer({
  open,
  rect,
  mode,
  quote,
  labels,
  initialLabel = null,
  onSubmit,
  onCancel,
  uploadImage,
}: Props) {
  const [body, setBody] = useState('')
  const [replacement, setReplacement] = useState(quote)
  const [label, setLabel] = useState<CommentLabel | null>(initialLabel)
  const [saving, setSaving] = useState(false)
  const [draw, setDraw] = useState<{ src: string; name: string } | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setBody('')
    setReplacement(quote)
    setLabel(initialLabel)
    queueMicrotask(() => taRef.current?.focus())
  }, [open, quote, initialLabel])

  const overCap = mode !== 'global' && quote.length > MAX_QUOTE
  const needsReplacement =
    mode === 'suggestion' &&
    (!replacement.trim() || replacement.trim() === quote.trim())
  const canSave =
    !saving &&
    !overCap &&
    !needsReplacement &&
    (mode === 'suggestion' || body.trim().length > 0 || label !== null)

  const insertAtCaret = (text: string) => {
    const ta = taRef.current
    const at = ta?.selectionStart ?? body.length
    setBody(b => b.slice(0, at) + text + b.slice(at))
    queueMicrotask(() => {
      ta?.focus()
      ta?.setSelectionRange(at + text.length, at + text.length)
    })
  }
  const upload = async (blob: Blob, name: string) => {
    try {
      const id = await uploadImage(blob, name)
      insertAtCaret(`{attachment:${id}}`)
    } catch {
      /* the mutation hook toasts; the token simply is not inserted */
    }
  }
  const submit = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      await onSubmit({
        body: body.trim(),
        suggested_text: mode === 'suggestion' ? replacement.trim() : undefined,
        label: label?.id ?? null,
      })
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null
  const anchorStyle = rect
    ? {
        top: rect.top + rect.height,
        left: rect.left,
        width: Math.max(1, rect.width),
        height: 1,
      }
    : { top: 8, right: 8, width: 1, height: 1 }

  return (
    <>
      <Popover open modal={false} onOpenChange={o => !o && onCancel()}>
        <PopoverAnchor asChild>
          <span aria-hidden className="absolute" style={anchorStyle} />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-[380px] p-3"
          onEscapeKeyDown={onCancel}
        >
          {mode !== 'global' && quote && (
            <p className="mb-2 line-clamp-2 border-l-2 pl-2 text-xs text-muted-foreground">
              “{quote}”
            </p>
          )}
          {overCap && (
            <p role="alert" className="mb-2 text-xs text-destructive">
              Selection is {quote.length} characters; the limit is {MAX_QUOTE}.
              Select less text.
            </p>
          )}
          {label && (
            <button
              type="button"
              className="mb-2 rounded-full border px-2 py-0.5 text-xs"
              onClick={() => setLabel(null)}
              title="Remove label"
            >
              {label.emoji} {label.text} ×
            </button>
          )}
          {!label && labels.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {labels.map(l => (
                <button
                  key={l.id}
                  type="button"
                  className="rounded-full border px-2 py-0.5 text-xs hover:bg-muted"
                  onClick={() => setLabel(l)}
                >
                  {l.emoji} {l.text}
                </button>
              ))}
            </div>
          )}
          {mode === 'suggestion' && (
            <div className="mb-2 text-xs">
              <span className="mb-1 block text-muted-foreground">
                Replace with
              </span>
              <Textarea
                aria-label="Replace with"
                value={replacement}
                rows={2}
                onChange={e => setReplacement(e.target.value)}
              />
            </div>
          )}
          <Textarea
            ref={taRef}
            value={body}
            rows={3}
            placeholder="Add a comment…"
            onChange={e => setBody(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onCancel()
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void submit()
              }
            }}
            onPaste={e => {
              const img = Array.from(e.clipboardData?.files ?? []).find(f =>
                f.type.startsWith('image/')
              )
              if (img) {
                e.preventDefault()
                void upload(img, img.name || 'pasted.png')
              }
            }}
            onDrop={e => {
              const img = Array.from(e.dataTransfer?.files ?? []).find(f =>
                f.type.startsWith('image/')
              )
              if (img) {
                e.preventDefault()
                void upload(img, img.name || 'dropped.png')
              }
            }}
          />
          <div className="mt-2 flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0]
                if (f) setDraw({ src: URL.createObjectURL(f), name: f.name })
                e.target.value = ''
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => fileRef.current?.click()}
              title="Attach an image (draw on it first)"
            >
              <ImagePlus className="h-4 w-4" />
            </Button>
            <span className="ml-auto text-xs text-muted-foreground">
              Ctrl+Enter
            </span>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" disabled={!canSave} onClick={() => void submit()}>
              Save
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {draw && (
        <ImageAnnotator
          imageSrc={draw.src}
          isOpen
          initialName={draw.name}
          onAccept={async (blob, _drew, name) => {
            await upload(blob, name.endsWith('.png') ? name : `${name}.png`)
          }}
          onClose={() => {
            URL.revokeObjectURL(draw.src)
            setDraw(null)
          }}
        />
      )}
    </>
  )
}
