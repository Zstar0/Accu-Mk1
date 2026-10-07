import { describe, expect, it } from 'vitest'
import { parseBridgeMessage } from '../bridge-messages'

const t = (type: string, rest: Record<string, unknown> = {}) => ({
  type: `plannotator-bridge-${type}`,
  ...rest,
})

describe('parseBridgeMessage', () => {
  it('rejects foreign and malformed messages', () => {
    expect(parseBridgeMessage(null)).toBeNull()
    expect(parseBridgeMessage({ type: 'other' })).toBeNull()
    expect(
      parseBridgeMessage(t('mark-click', { id: 'x'.repeat(257) }))
    ).toBeNull()
    expect(
      parseBridgeMessage(
        t('selection', {
          text: 'a'.repeat(10_001),
          rect: { top: 0, left: 0, width: 1, height: 1 },
        })
      )
    ).toBeNull()
    expect(
      parseBridgeMessage(
        t('headings', {
          headings: new Array(501).fill({ id: 'a', level: 1, text: 'b' }),
        })
      )
    ).toBeNull()
    expect(
      parseBridgeMessage(
        t('headings', { headings: [{ id: 'a', level: 9, text: 'b' }] })
      )
    ).toBeNull()
  })

  it('clamps resize heights', () => {
    expect(parseBridgeMessage(t('resize', { height: 1e9 }))).toEqual({
      type: 'resize',
      height: 50_000,
    })
    expect(parseBridgeMessage(t('resize', { height: 5 }))).toEqual({
      type: 'resize',
      height: 200,
    })
    expect(parseBridgeMessage(t('resize', { height: Number.NaN }))).toBeNull()
  })

  it('parses a selection and drops an invalid element anchor without dropping the selection', () => {
    const m = parseBridgeMessage(
      t('selection', {
        text: 'quoted',
        rect: { top: 1, left: 2, width: 3, height: 4 },
        pinpoint: true,
        anchor: { selector: 'p', tagName: 'p' },
        context: { tag: 'p', heading: 'h2 "X"' },
      })
    )
    expect(m).toMatchObject({
      type: 'selection',
      selection: {
        text: 'quoted',
        pinpoint: true,
        anchor: { selector: 'p', tagName: 'p' },
      },
    })
    const bad = parseBridgeMessage(
      t('selection', {
        text: 'q',
        rect: { top: 0, left: 0, width: 0, height: 0 },
        anchor: { selector: 5 },
      })
    )
    expect(bad).toMatchObject({
      type: 'selection',
      selection: { anchor: null },
    })
  })

  it('parses unanchored ids, link clicks, and serialized html with caps', () => {
    expect(
      parseBridgeMessage(t('unanchored', { ids: ['1', 2, 'x'.repeat(300)] }))
    ).toEqual({ type: 'unanchored', ids: ['1'] })
    expect(
      parseBridgeMessage(t('link-click', { href: 'https://a.b/c' }))
    ).toEqual({ type: 'link-click', href: 'https://a.b/c' })
    expect(
      parseBridgeMessage(t('serialized', { html: '<p>x</p>', appliedId: '7' }))
    ).toEqual({ type: 'serialized', html: '<p>x</p>', appliedId: '7' })
  })

  it('rejects a non-integer heading level', () => {
    expect(
      parseBridgeMessage(
        t('headings', { headings: [{ id: 'a', level: 2.5, text: 'b' }] })
      )
    ).toBeNull()
  })
})
