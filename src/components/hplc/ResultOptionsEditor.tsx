import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { X, Plus } from 'lucide-react'

export interface ResultOption {
  value: string
  label: string
}

/** Add / edit / remove list of {value, label} result options. Controlled. */
export function ResultOptionsEditor({
  options,
  onChange,
}: {
  options: ResultOption[]
  onChange: (next: ResultOption[]) => void
}) {
  const setRow = (i: number, patch: Partial<ResultOption>) =>
    onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)))
  const removeRow = (i: number) => onChange(options.filter((_, j) => j !== i))
  const addRow = () => onChange([...options, { value: '', label: '' }])

  return (
    <div className="space-y-2">
      {options.map((o, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            className="h-8 w-24 font-mono text-sm"
            value={o.value}
            placeholder="value"
            aria-label={`Option ${i + 1} value`}
            onChange={e => setRow(i, { value: e.target.value })}
          />
          <Input
            className="h-8 flex-1 text-sm"
            value={o.label}
            placeholder="label"
            aria-label={`Option ${i + 1} label`}
            onChange={e => setRow(i, { label: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label={`Remove option ${o.value || i + 1}`}
            onClick={() => removeRow(i)}
          >
            <X size={14} />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        <Plus size={14} className="mr-1" /> Add option
      </Button>
    </div>
  )
}
