import { describe, it, expect } from 'vitest'
import { parseWorksheetNotes, withNotesText } from '@/lib/worksheet-notes'

describe('worksheet notes', () => {
  it('reads plain text as the analyst text', () => {
    expect(parseWorksheetNotes('plain')).toEqual({
      userNotes: 'plain',
      prepStartedItems: new Set(),
    })
  })

  it('reads the text and the prep-started markers out of the JSON', () => {
    const raw = JSON.stringify({ text: 'hi', 'prep_started:abc': true })
    expect(parseWorksheetNotes(raw)).toEqual({
      userNotes: 'hi',
      prepStartedItems: new Set(['abc']),
    })
  })

  it('replaces the text and keeps every marker', () => {
    const raw = JSON.stringify({ 'prep_started:abc': true, text: 'old' })
    expect(JSON.parse(withNotesText(raw, 'new'))).toEqual({
      'prep_started:abc': true,
      text: 'new',
    })
    expect(JSON.parse(withNotesText('old plain text', 'new'))).toEqual({
      text: 'new',
    })
  })
})
