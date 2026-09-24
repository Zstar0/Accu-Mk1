import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { WorksheetNote } from '@/lib/api'
import type { LabCalendar } from '@/lib/endo-prep'
import {
  LEGACY_NOTE_AUTHOR,
  UNKNOWN_AUTHOR,
  noteStamp,
} from '@/lib/worksheet-notes'

const NOTE_MAX = 2000

/**
 * A worksheet's notes as a log: every note shows who wrote it and when, and a
 * box below adds the next one. Notes are never edited or deleted; the typed
 * text is only cleared once the server has saved it.
 */
export function WorksheetNoteLog({
  notes,
  legacyText,
  isCompleted,
  calendar = null,
  onAdd,
}: {
  notes: WorksheetNote[]
  /** Free text typed before the log existed, shown first. */
  legacyText: string
  isCompleted: boolean
  calendar?: LabCalendar | null
  onAdd: (body: string) => Promise<unknown>
}) {
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const body = draft.trim()

  async function add() {
    if (!body || saving) return
    setSaving(true)
    setError(null)
    try {
      await onAdd(body)
      setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The note was not saved')
    } finally {
      setSaving(false)
    }
  }

  const legacy = legacyText.trim()
  const empty = !legacy && notes.length === 0

  return (
    <div className="space-y-2">
      {empty && isCompleted && (
        <p className="text-sm text-muted-foreground">-</p>
      )}
      {!empty && (
        <ul className="space-y-1.5">
          {legacy && (
            <li className="rounded-md border border-border bg-card px-3 py-2">
              <div className="text-xs italic text-muted-foreground">
                {LEGACY_NOTE_AUTHOR}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-sm">{legacy}</p>
            </li>
          )}
          {notes.map(n => (
            <li
              key={n.id}
              className="rounded-md border border-border bg-card px-3 py-2"
            >
              <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {n.author ?? UNKNOWN_AUTHOR}
                </span>
                <time dateTime={n.created_at} className="tabular-nums">
                  {noteStamp(n.created_at, calendar)}
                </time>
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-sm">{n.body}</p>
            </li>
          ))}
        </ul>
      )}
      {!isCompleted && (
        <div className="space-y-1.5">
          <Textarea
            aria-label="New note"
            className="min-h-[60px] resize-none bg-card text-sm"
            placeholder="Deviations, lot numbers, observations…"
            maxLength={NOTE_MAX}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void add()
              }
            }}
          />
          <div className="flex items-center justify-between gap-3">
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : (
              <span className="text-xs text-muted-foreground">
                Saved with your name and the time. Ctrl+Enter adds it.
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={!body || saving}
              onClick={() => void add()}
            >
              Add note
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
