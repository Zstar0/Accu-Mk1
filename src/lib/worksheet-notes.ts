/**
 * Worksheet notes: an append-only log, each note stamped by the server with
 * who wrote it and when (Handler, 2026-09-23). The free text typed before the
 * log existed stays readable as an earlier note with no recorded author.
 */
import type { WorksheetNote } from '@/lib/api'
import { labDate, labTime, type LabCalendar } from '@/lib/endo-prep'

export const LEGACY_NOTE_AUTHOR = 'Earlier note, author not recorded'
export const UNKNOWN_AUTHOR = 'Unknown user'

/** "2026-09-23 3:05 PM" in the lab's time zone (the browser's without one). */
export function noteStamp(iso: string, cal: LabCalendar | null): string {
  const c = cal ?? {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    workingDays: [],
    holidays: new Map<string, string>(),
  }
  return [labDate(iso, c), labTime(iso, c)].filter(Boolean).join(' ')
}

/** The notes as plain text for the printed sheet, one stamped note a block. */
export function worksheetNotesText(
  notes: WorksheetNote[],
  legacyText: string,
  cal: LabCalendar | null
): string {
  const blocks = notes.map(
    n =>
      `${n.author ?? UNKNOWN_AUTHOR}, ${noteStamp(n.created_at, cal)}: ${n.body}`
  )
  if (legacyText.trim())
    blocks.unshift(`${LEGACY_NOTE_AUTHOR}: ${legacyText.trim()}`)
  return blocks.join('\n')
}

/**
 * The free-text `notes` column holds JSON: the analyst's text under `text`
 * and `prep_started:<key>` markers. Plain text from before that is read as
 * the analyst's text. Lifted out of WorksheetDrawer unchanged so the flyout
 * and the endo worksheet page edit notes the same way.
 */
export function parseWorksheetNotes(raw: string): {
  userNotes: string
  prepStartedItems: Set<string>
} {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Plain text notes (not JSON): treat as user text
    return { userNotes: raw, prepStartedItems: new Set<string>() }
  }
  const set = new Set<string>()
  for (const key of Object.keys(parsed)) {
    if (key.startsWith('prep_started:')) {
      set.add(key.replace('prep_started:', ''))
    }
  }
  const text = typeof parsed.text === 'string' ? parsed.text : ''
  return { userNotes: text, prepStartedItems: set }
}

/** The notes JSON with the analyst's text replaced and every marker kept. */
export function withNotesText(raw: string, text: string): string {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = {}
  }
  parsed.text = text
  return JSON.stringify(parsed)
}
