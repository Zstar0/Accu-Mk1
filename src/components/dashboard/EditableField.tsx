import { useState, useRef, useEffect } from 'react'
import { Check, X, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { updateSenaiteSampleFields } from '@/lib/api'

// --- EditableField: Click-to-edit inline field with save/cancel ---

interface EditableFieldProps {
  label: string
  value: string | number | null
  senaiteField?: string
  sampleUid?: string
  type?: 'text' | 'number' | 'textarea'
  mono?: boolean
  emphasis?: boolean
  suffix?: string
  truncateStart?: boolean
  formatDisplay?: (v: string | number | null) => React.ReactNode
  onSaved?: (newValue: string | number | null) => void
  /** Custom save function — when provided, bypasses the SENAITE update API. */
  onSave?: (newValue: string | number | null) => Promise<void>
}

export function EditableField({
  label,
  value,
  senaiteField,
  sampleUid,
  type = 'text',
  mono = false,
  emphasis = false,
  suffix,
  truncateStart = false,
  formatDisplay,
  onSaved,
  onSave,
}: EditableFieldProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  // Focus input when entering edit mode
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      // Select all text for easy replacement
      if ('select' in inputRef.current) {
        inputRef.current.select()
      }
    }
  }, [editing])

  const displayValue = value ?? ''

  function startEditing() {
    if (saving) return
    setDraft(String(displayValue))
    setEditing(true)
  }

  function cancelEditing() {
    setEditing(false)
    setDraft('')
  }

  async function save() {
    const trimmed = draft.trim()
    const newValue = type === 'number' && trimmed !== '' ? Number(trimmed) : trimmed || null

    // No change — just close
    if (String(newValue ?? '') === String(value ?? '')) {
      cancelEditing()
      return
    }

    const previousValue = value
    setSaving(true)

    // Optimistic update
    onSaved?.(newValue)

    try {
      if (onSave) {
        await onSave(newValue)
      } else {
        const result = await updateSenaiteSampleFields(sampleUid!, {
          [senaiteField!]: newValue,
        })
        if (!result.success) {
          throw new Error(result.message)
        }
      }
      toast.success(`${label} updated`)
      setEditing(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      toast.error(`Failed to update ${label}`, { description: msg })
      // Rollback optimistic update
      onSaved?.(previousValue)
    } finally {
      setSaving(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && type !== 'textarea') {
      e.preventDefault()
      save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEditing()
    }
  }

  // --- Edit mode ---
  if (editing) {
    const inputClasses = 'h-7 text-sm px-2 py-1'

    return (
      <div className="flex items-center gap-1.5 min-w-0">
        {type === 'textarea' ? (
          <Textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault()
                cancelEditing()
              }
            }}
            disabled={saving}
            className="min-h-15 text-sm px-2 py-1.5 flex-1"
            aria-label={`Edit ${label}`}
          />
        ) : (
          <Input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type={type === 'number' ? 'number' : 'text'}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={saving}
            className={`${inputClasses} flex-1 ${mono ? 'font-mono' : ''}`}
            aria-label={`Edit ${label}`}
          />
        )}
        {suffix && <span className="text-xs text-muted-foreground shrink-0">{suffix}</span>}
        <button
          onClick={save}
          disabled={saving}
          className="inline-flex items-center justify-center w-6 h-6 rounded-md text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
          aria-label="Save"
        >
          {saving ? <Spinner className="size-3.5" /> : <Check size={14} />}
        </button>
        <button
          onClick={cancelEditing}
          disabled={saving}
          className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50 shrink-0"
          aria-label="Cancel"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  // --- Display mode ---
  const rendered = formatDisplay ? formatDisplay(value) : (String(value ?? '') || '—')

  return (
    <button
      onClick={startEditing}
      className="group inline-flex items-center gap-1.5 max-w-full text-right cursor-pointer rounded-md px-1 -mx-1 py-0.5 -my-0.5 hover:bg-muted/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Edit ${label}`}
    >
      <span
        className={`text-sm truncate ${
          emphasis ? 'font-semibold text-foreground' : 'text-foreground'
        } ${mono ? 'font-mono' : ''}`}
        {...(truncateStart ? { style: { direction: 'rtl' as const } } : {})}
      >
        {rendered}
      </span>
      <Pencil
        size={12}
        className="text-muted-foreground/0 group-hover:text-muted-foreground transition-colors shrink-0"
      />
    </button>
  )
}

// --- EditableDataRow: DataRow layout with inline editing ---

interface EditableDataRowProps {
  label: string
  value: string | number | null
  senaiteField?: string
  sampleUid?: string
  type?: 'text' | 'number' | 'textarea'
  mono?: boolean
  emphasis?: boolean
  suffix?: string
  truncateStart?: boolean
  formatDisplay?: (v: string | number | null) => React.ReactNode
  onSaved?: (newValue: string | number | null) => void
  onSave?: (newValue: string | number | null) => Promise<void>
  children?: React.ReactNode
}

export function EditableDataRow({
  label,
  value,
  senaiteField,
  sampleUid,
  type = 'text',
  mono = false,
  emphasis = false,
  suffix,
  truncateStart = false,
  formatDisplay,
  onSaved,
  onSave,
  children,
}: EditableDataRowProps) {
  return (
    <div className="flex items-baseline justify-between py-1.5 border-b border-border/50 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0 min-w-28 mr-3">{label}</span>
      <div className="flex items-center gap-2 min-w-0 flex-1 justify-end">
        {children}
        <EditableField
          label={label}
          value={value}
          senaiteField={senaiteField}
          sampleUid={sampleUid}
          type={type}
          mono={mono}
          emphasis={emphasis}
          suffix={suffix}
          truncateStart={truncateStart}
          formatDisplay={formatDisplay}
          onSaved={onSaved}
          onSave={onSave}
        />
      </div>
    </div>
  )
}
