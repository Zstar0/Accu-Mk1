import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorksheetNoteLog } from '@/components/hplc/WorksheetNoteLog'
import type { WorksheetNote } from '@/lib/api'
import { worksheetNotesText } from '@/lib/worksheet-notes'

// Worksheet notes are an append-only log: each note shows who wrote it and
// when (Handler, 2026-09-23). Typed text is only cleared once it has saved.

const notes: WorksheetNote[] = [
  {
    id: 1,
    body: 'Lot 42A master mix',
    user_id: 2,
    author: 'Guian Hernandez',
    created_at: '2026-09-23T19:05:00Z',
  },
  {
    id: 2,
    body: 'NPC re-run after a slip',
    user_id: 3,
    author: null,
    created_at: '2026-09-23T20:10:00Z',
  },
]

describe('WorksheetNoteLog', () => {
  it('shows every note with its author and time, and the earlier free-text note first', () => {
    render(
      <WorksheetNoteLog
        notes={notes}
        legacyText="typed before notes were logged"
        isCompleted={false}
        onAdd={vi.fn()}
      />
    )
    const items = screen
      .getAllByRole('listitem')
      .map(li => li.textContent ?? '')
    expect(items[0]).toContain('typed before notes were logged')
    expect(items[0]).toContain('author not recorded')
    expect(items[1]).toContain('Guian Hernandez')
    expect(items[1]).toContain('Lot 42A master mix')
    expect(items[2]).toContain('Unknown user')
    expect(items[2]).toContain('NPC re-run after a slip')
  })

  it('adds a trimmed note and clears the box once it has saved', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(
      <WorksheetNoteLog
        notes={[]}
        legacyText=""
        isCompleted={false}
        onAdd={onAdd}
      />
    )
    const box = screen.getByLabelText('New note') as HTMLTextAreaElement
    const add = screen.getByRole('button', { name: 'Add note' })
    expect(add).toBeDisabled()
    fireEvent.change(box, { target: { value: '  IPC lot 7  ' } })
    fireEvent.click(add)
    expect(onAdd).toHaveBeenCalledWith('IPC lot 7')
    await waitFor(() => expect(box.value).toBe(''))
  })

  it('keeps the typed text and says why when the save fails', async () => {
    const onAdd = vi.fn().mockRejectedValue(new Error('Worksheet is completed'))
    render(
      <WorksheetNoteLog
        notes={[]}
        legacyText=""
        isCompleted={false}
        onAdd={onAdd}
      />
    )
    const box = screen.getByLabelText('New note') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'IPC lot 7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Worksheet is completed'
    )
    expect(box.value).toBe('IPC lot 7')
  })

  it('is read-only on a completed worksheet', () => {
    render(
      <WorksheetNoteLog
        notes={notes}
        legacyText=""
        isCompleted={true}
        onAdd={vi.fn()}
      />
    )
    expect(screen.queryByLabelText('New note')).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('prints each note with who wrote it and when, in the lab time zone', () => {
    const cal = {
      timezone: 'America/Chicago',
      workingDays: [0, 1, 2, 3, 4],
      holidays: new Map<string, string>(),
    }
    expect(
      worksheetNotesText(notes, ' typed before ', cal).split('\n')
    ).toEqual([
      'Earlier note, author not recorded: typed before',
      'Guian Hernandez, 2026-09-23 2:05 PM: Lot 42A master mix',
      'Unknown user, 2026-09-23 3:10 PM: NPC re-run after a slip',
    ])
    expect(worksheetNotesText([], '', cal)).toBe('')
  })
})
