import { useState, useRef } from 'react'
import { Check, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { WorksheetListItem } from '@/lib/api'

interface WorksheetDrawerHeaderProps {
  worksheet: WorksheetListItem
  users: { id: number; email: string }[]
  onUpdate: (data: { title?: string; assigned_analyst?: number; notes?: string }) => void
  isCompleted: boolean
}

const STATUS_CLASSES: Record<string, string> = {
  open: 'bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300',
  completed: 'bg-zinc-100 text-zinc-600 border border-zinc-200 dark:bg-zinc-900/30 dark:text-zinc-400',
  cancelled: 'bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/30 dark:text-red-300',
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function WorksheetDrawerHeader({
  worksheet,
  users,
  onUpdate,
  isCompleted,
}: WorksheetDrawerHeaderProps) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(worksheet.title)
  const [notesValue, setNotesValue] = useState(worksheet.notes ?? '')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function startEdit() {
    if (isCompleted) return
    setTitleDraft(worksheet.title)
    setEditingTitle(true)
  }

  function saveTitle() {
    const trimmed = titleDraft.trim()
    if (!trimmed) {
      setTitleDraft(worksheet.title)
      setEditingTitle(false)
      return
    }
    if (trimmed !== worksheet.title) {
      onUpdate({ title: trimmed })
    }
    setEditingTitle(false)
  }

  function cancelEdit() {
    setTitleDraft(worksheet.title)
    setEditingTitle(false)
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') saveTitle()
    if (e.key === 'Escape') cancelEdit()
  }

  function handleNotesChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setNotesValue(e.target.value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      onUpdate({ notes: e.target.value })
    }, 800)
  }

  function handleNotesBlur() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    onUpdate({ notes: notesValue })
  }

  const statusClass = STATUS_CLASSES[worksheet.status] ?? STATUS_CLASSES.open

  return (
    <div className="px-4 pt-4 pb-2 border-b space-y-2">
      {/* Title row */}
      <div className="flex items-center gap-1 min-h-[28px]">
        {editingTitle ? (
          <>
            <Input
              className="h-7 text-base flex-1"
              value={titleDraft}
              autoFocus
              onChange={e => setTitleDraft(e.target.value)}
              onKeyDown={handleTitleKeyDown}
            />
            <button
              onClick={saveTitle}
              className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground"
              aria-label="Save title"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={cancelEdit}
              className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground"
              aria-label="Cancel edit"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <span
            className={`text-base font-semibold leading-tight ${isCompleted ? '' : 'cursor-pointer hover:text-primary'}`}
            onClick={startEdit}
          >
            {worksheet.title}
          </span>
        )}
      </div>

      {/* Status row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ${statusClass}`}>
          {worksheet.status}
        </span>
        <span className="text-xs text-muted-foreground">{worksheet.item_count} items</span>
        <span className="text-xs text-muted-foreground">{formatDate(worksheet.created_at)}</span>
      </div>

      {/* Tech dropdown */}
      {isCompleted ? (
        <p className="text-sm text-muted-foreground">
          {worksheet.assigned_analyst_email ?? 'No tech assigned'}
        </p>
      ) : (
        <Select
          value={worksheet.assigned_analyst ? String(worksheet.assigned_analyst) : undefined}
          onValueChange={value => onUpdate({ assigned_analyst: Number(value) })}
        >
          <SelectTrigger className="h-8 w-full">
            <SelectValue placeholder="Assign tech..." />
          </SelectTrigger>
          <SelectContent>
            {users.map(user => (
              <SelectItem key={user.id} value={String(user.id)}>
                {user.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Notes textarea */}
      {isCompleted ? (
        <p className="text-sm text-muted-foreground whitespace-pre-wrap">{notesValue || '—'}</p>
      ) : (
        <Textarea
          className="min-h-[72px] resize-none text-sm"
          placeholder="Add notes..."
          value={notesValue}
          onChange={handleNotesChange}
          onBlur={handleNotesBlur}
        />
      )}
    </div>
  )
}

export default WorksheetDrawerHeader
