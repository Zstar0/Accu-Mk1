import { describe, expect, it } from 'vitest'
import {
  INJECT_CLOSE,
  INJECT_OPEN,
  stripViewerInjection,
} from '../stripViewerInjection'

const ORIGINAL =
  '<!doctype html><html><head><style>/* accumark-docs v1 */</style></head><body><p>Hi</p></body></html>'
const THEMED_ORIGINAL =
  '<!doctype html><html data-theme="light"><head></head><body><p>Hi</p></body></html>'

describe('stripViewerInjection', () => {
  it('removes the injection block, the bridge script tag, the stamp, and contenteditable; author bytes stay', () => {
    const viewed = ORIGINAL.replace('<html>', '<html data-theme="dark">')
      .replace(
        '</head>',
        `${INJECT_OPEN}<style>:root{--pn-x:1}</style><script src="http://m/pn-bridge.v1.js"></script>${INJECT_CLOSE}</head>`
      )
      .replace('<body>', '<body contenteditable="true">')
    expect(stripViewerInjection(viewed, ORIGINAL)).toBe(ORIGINAL)
  })

  it('restores an author-set data-theme instead of removing it', () => {
    const viewed = THEMED_ORIGINAL.replace(
      'data-theme="light"',
      'data-theme="dark"'
    )
    expect(stripViewerInjection(viewed, THEMED_ORIGINAL)).toBe(THEMED_ORIGINAL)
  })

  it('is a no-op on untouched html', () => {
    expect(stripViewerInjection(ORIGINAL, ORIGINAL)).toBe(ORIGINAL)
  })

  it('removes contenteditable only from the body tag; author elements and code samples survive', () => {
    const authored =
      '<!doctype html><html><head></head><body><div contenteditable="true">x</div><p>&lt;div contenteditable="true"&gt;</p></body></html>'
    const viewed = authored.replace('<body>', '<body contenteditable="true">')
    expect(stripViewerInjection(viewed, authored)).toBe(authored)
  })

  it('only removes the real head block; author markers in the body are left alone', () => {
    const authored = `<!doctype html><html><head></head><body><p>a</p>${INJECT_CLOSE}<p>b</p>${INJECT_OPEN}<p>c</p></body></html>`
    const viewed = authored.replace(
      '</head>',
      `${INJECT_OPEN}<style>x{}</style>${INJECT_CLOSE}</head>`
    )
    expect(stripViewerInjection(viewed, authored)).toBe(authored)
  })

  it('restores an unquoted authored data-theme', () => {
    const orig =
      '<!doctype html><html data-theme=light><head></head><body></body></html>'
    const viewed = orig.replace('data-theme=light', 'data-theme="dark"')
    expect(stripViewerInjection(viewed, orig)).toBe(orig)
  })
})
