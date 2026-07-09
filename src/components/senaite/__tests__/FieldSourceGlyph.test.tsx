import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FieldSourceGlyph } from '@/components/senaite/FieldSourceGlyph'
import { detailsFieldSource } from '@/lib/read-source'

describe('detailsFieldSource', () => {
  const sources = { client: 'mk1', client_lot: 'senaite' } as const

  it('is undefined outside mk1 mode (no glyphs in SENAITE mode)', () => {
    expect(detailsFieldSource(undefined, sources, 'client')).toBeUndefined()
    expect(detailsFieldSource('senaite', sources, 'client')).toBeUndefined()
  })

  it('returns the mapped source in mk1 mode', () => {
    expect(detailsFieldSource('mk1', sources, 'client')).toBe('mk1')
    expect(detailsFieldSource('mk1', sources, 'client_lot')).toBe('senaite')
  })

  it('treats an absent key as SENAITE-owned (review_state rule)', () => {
    expect(detailsFieldSource('mk1', sources, 'review_state')).toBe('senaite')
    expect(detailsFieldSource('mk1', undefined, 'client')).toBe('senaite')
  })
})

describe('FieldSourceGlyph', () => {
  it('renders nothing unless the field is SENAITE-sourced', () => {
    const { container: c1 } = render(<FieldSourceGlyph source="mk1" field="Client" />)
    expect(c1).toBeEmptyDOMElement()
    const { container: c2 } = render(<FieldSourceGlyph source={undefined} field="Client" />)
    expect(c2).toBeEmptyDOMElement()
  })

  it('renders the glyph for a SENAITE-sourced field', () => {
    render(<FieldSourceGlyph source="senaite" field="State" />)
    expect(screen.getByLabelText('State: live from SENAITE')).toBeInTheDocument()
  })
})
