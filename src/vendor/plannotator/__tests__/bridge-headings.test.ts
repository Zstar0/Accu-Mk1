import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadBridge } from './bridge-harness'

let b: ReturnType<typeof loadBridge>

beforeAll(async () => {
  b = loadBridge('<h1>Title</h1><p>body</p><h2 id="own">Own</h2><h3>Deep <em>one</em></h3>')
  await b.tick()
  await b.tick()
})
afterAll(() => b.dispose())

describe('headings extension', () => {
  it('posts ready then the heading list, minting ids where the author gave none', () => {
    expect(b.last('ready')).toMatchObject({ protocolVersion: 1 })
    expect(b.last('headings')?.headings).toEqual([
      { id: 'pn-h-1', level: 1, text: 'Title' },
      { id: 'own', level: 2, text: 'Own' },
      { id: 'pn-h-2', level: 3, text: 'Deep one' },
    ])
    expect(document.querySelector('h1')?.id).toBe('pn-h-1')
  })

  it('re-posts after a mutation adds a heading, and not when nothing changed', async () => {
    const before = b.posted.filter(m => m.type === 'plannotator-bridge-headings').length
    document.body.insertAdjacentHTML('beforeend', '<h2>Added</h2>')
    await new Promise(r => setTimeout(r, 250))
    const after = b.posted.filter(m => m.type === 'plannotator-bridge-headings')
    expect(after.length).toBe(before + 1)
    expect(after.at(-1)?.headings).toHaveLength(4)
    document.body.insertAdjacentHTML('beforeend', '<p>no heading</p>')
    await new Promise(r => setTimeout(r, 250))
    expect(b.posted.filter(m => m.type === 'plannotator-bridge-headings').length).toBe(before + 1)
  })

  it('scroll-to-fragment scrolls a minted id into view', async () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')
    await b.send({ type: 'plannotator-bridge-scroll-to-fragment', fragment: 'pn-h-2' })
    expect(spy).toHaveBeenCalled()
  })

  it('caps text at 130 chars and the list at 500', async () => {
    document.body.insertAdjacentHTML('beforeend', `<h4>${'x'.repeat(200)}</h4>`)
    await new Promise(r => setTimeout(r, 250))
    const list = b.last('headings')?.headings as Array<{ text: string }>
    expect(list.at(-1)?.text).toHaveLength(130)
  })
})
