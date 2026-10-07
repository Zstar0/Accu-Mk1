import { useEffect } from 'react'
import { MessageSquare, Pencil, Tag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { CommentLabel } from '@/lib/api-document-comments'
import type { Rect } from './bridge-messages'

interface Props {
  /** Selection rect already offset into the positioning container's coordinates. */
  rect: Rect
  labels: CommentLabel[]
  onComment: () => void
  onSuggest: () => void
  onLabel: (label: CommentLabel) => void
  onThumbsUp: () => void
}

/** Floats above a selection or a pinpointed element (spec §8). */
export function SelectionToolbar({
  rect,
  labels,
  onComment,
  onSuggest,
  onLabel,
  onThumbsUp,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Typing into any field (a reply box, a dialog) is never a shortcut.
      if (
        e.target instanceof Element &&
        e.target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
        )
      )
        return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (!/^[0-9]$/.test(e.key)) return
      const i = e.key === '0' ? 9 : Number(e.key) - 1
      const label = labels[i]
      if (label) {
        e.preventDefault()
        onLabel(label)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [labels, onLabel])

  return (
    <div
      role="toolbar"
      aria-label="Annotate selection"
      data-testid="selection-toolbar"
      className="absolute z-20 flex items-center gap-0.5 rounded-md border bg-popover p-1 shadow-md"
      style={{ top: Math.max(0, rect.top - 40), left: Math.max(0, rect.left) }}
    >
      <Button size="sm" variant="ghost" onClick={onComment}>
        <MessageSquare className="mr-1 h-4 w-4" />
        Comment
      </Button>
      <Button size="sm" variant="ghost" onClick={onSuggest}>
        <Pencil className="mr-1 h-4 w-4" />
        Suggest edit
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost">
            <Tag className="mr-1 h-4 w-4" />
            Label
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {labels.map((l, i) => (
            <DropdownMenuItem key={l.id} onSelect={() => onLabel(l)}>
              <span className="mr-2">{l.emoji}</span>
              {l.text}
              <span className="ml-auto pl-4 text-xs text-muted-foreground">
                {(i + 1) % 10}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        size="sm"
        variant="ghost"
        aria-label="Nice work"
        onClick={onThumbsUp}
      >
        👍
      </Button>
    </div>
  )
}
