// src/vendor/plannotator/__tests__/bridge-edit-mode.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadBridge } from './bridge-harness'

let b: ReturnType<typeof loadBridge>

beforeAll(async () => {
  b = loadBridge('<h2>Section</h2><p>Hello world, hello <em>again</em>.</p>', '<title>t</title><style>p{color:red}</style>')
  await b.tick()
})
afterAll(() => b.dispose())

describe('edit-mode extension', () => {
  it('toggles contenteditable on the body', async () => {
    await b.send({ type: 'plannotator-bridge-set-edit-mode', on: true })
    expect(document.body.getAttribute('contenteditable')).toBe('true')
    await b.send({ type: 'plannotator-bridge-set-edit-mode', on: false })
    expect(document.body.hasAttribute('contenteditable')).toBe(false)
  })

  it('serialize returns a doctype-prefixed document with viewer nodes, the editable flag and minted ids gone', async () => {
    // the overlay host is built lazily: mark something so there is a viewer node to strip
    await b.send({ type: 'plannotator-bridge-find-and-mark', id: 'c0', annotationType: 'comment', originalText: 'Section', anchor: null, additionalAnchors: null })
    await b.send({ type: 'plannotator-bridge-set-edit-mode', on: true })
    expect(document.querySelector('[data-plannotator-overlay-host]')).not.toBeNull()
    await b.send({ type: 'plannotator-bridge-serialize' })
    const html = b.last('serialized')?.html as string
    expect(html.startsWith('<!doctype html>\n<html')).toBe(true)
    expect(html).toContain('<p>Hello world, hello <em>again</em>.</p>')
    expect(html).toContain('<style>p{color:red}</style>')
    expect(html).toContain('<h2>Section</h2>')
    expect(html).not.toMatch(/contenteditable|data-plannotator-|pn-h-/)
    // the live document keeps its overlay and its editable flag
    expect(document.querySelector('[data-plannotator-overlay-host]')).not.toBeNull()
    expect(document.body.getAttribute('contenteditable')).toBe('true')
    await b.send({ type: 'plannotator-bridge-set-edit-mode', on: false })
  })

  it('apply-replacement swaps the restored range for the text and serializes with appliedId', async () => {
    await b.send({ type: 'plannotator-bridge-find-and-mark', id: 'c1', annotationType: 'deletion', originalText: 'world', anchor: null, additionalAnchors: null })
    expect(b.last('mark-applied')).toMatchObject({ id: 'c1', success: true })
    await b.send({ type: 'plannotator-bridge-apply-replacement', id: 'c1', text: 'there' })
    const msg = b.last('serialized')
    expect(msg?.appliedId).toBe('c1')
    expect(msg?.html as string).toContain('<p>Hello there, hello <em>again</em>.</p>')
    expect(document.body.textContent).toContain('Hello there')
  })

  it('apply-replacement on an unknown or dead id posts apply-failed', async () => {
    await b.send({ type: 'plannotator-bridge-apply-replacement', id: 'nope', text: 'x' })
    expect(b.last('apply-failed')).toMatchObject({ id: 'nope' })
  })
})
