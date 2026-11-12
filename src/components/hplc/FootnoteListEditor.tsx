import type { ReactNode } from 'react'
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { Footnote } from './coa-variant-logic'

export function FootnoteListEditor({
  value,
  onChange,
  header,
}: {
  value: Footnote[]
  onChange: (next: Footnote[]) => void
  header?: ReactNode
}) {
  const addFootnote = () => {
    onChange([...value, { label: '', text: '' }])
  }

  const removeFootnote = (index: number) => {
    onChange(value.filter((_, i) => i !== index))
  }

  const updateFootnote = (index: number, patch: Partial<Footnote>) => {
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const moveFootnote = (index: number, direction: -1 | 1) => {
    const target = index + direction
    const indexRow = value[index]
    const targetRow = value[target]
    if (!indexRow || !targetRow) return
    const next = [...value]
    next[index] = targetRow
    next[target] = indexRow
    onChange(next)
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        {header}
        <Button type="button" size="sm" variant="outline" onClick={addFootnote}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add Footnote
        </Button>
      </div>

      {value.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">No footnotes.</p>
      ) : (
        <div className="space-y-2">
          {value.map((footnote, index) => (
            <div key={index} className="flex gap-2 rounded-md border p-2">
              <div className="flex-1 space-y-1.5">
                <Input
                  aria-label={`Footnote ${index + 1} label`}
                  placeholder="Label"
                  value={footnote.label}
                  onChange={e =>
                    updateFootnote(index, { label: e.target.value })
                  }
                />
                <Textarea
                  aria-label={`Footnote ${index + 1} text`}
                  className="min-h-[52px] text-xs"
                  placeholder="Footnote text"
                  value={footnote.text}
                  onChange={e =>
                    updateFootnote(index, { text: e.target.value })
                  }
                />
              </div>
              <div className="flex flex-col gap-0.5 shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={index === 0}
                  aria-label={`Move footnote ${index + 1} up`}
                  onClick={() => moveFootnote(index, -1)}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={index === value.length - 1}
                  aria-label={`Move footnote ${index + 1} down`}
                  onClick={() => moveFootnote(index, 1)}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-destructive hover:text-destructive"
                  aria-label={`Remove footnote ${index + 1}`}
                  onClick={() => removeFootnote(index)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
