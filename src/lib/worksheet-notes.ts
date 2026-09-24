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
