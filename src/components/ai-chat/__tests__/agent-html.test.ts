import { describe, expect, it } from 'vitest'
import { renderAgentHtml } from '../agent-html'

/** Parse the helper's output the way the page will, into an inert template. */
function parse(text: string) {
  const template = document.createElement('template')
  template.innerHTML = renderAgentHtml(text)
  return template.content
}
const visible = (text: string) => parse(text).textContent ?? ''

describe('renderAgentHtml', () => {
  it('shows a link as its label plus the full destination, and no anchor', () => {
    const dom = parse('[click](https://evil.example/?d=secret)')
    expect(dom.querySelector('a')).toBeNull()
    expect(dom.textContent).toContain('click (https://evil.example/?d=secret)')
  })

  it('shows the destination exactly as written, not resolved against the page', () => {
    expect(visible('[docs](/relative/path?a=1&b=2)')).toContain(
      'docs (/relative/path?a=1&b=2)'
    )
  })

  it('shows a bare URL once, not twice', () => {
    const text = visible('see https://example.com/report for more')
    expect(
      parse('see https://example.com/report').querySelector('a')
    ).toBeNull()
    expect(text.match(/example\.com\/report/g)).toHaveLength(1)
    expect(text).toContain('see https://example.com/report for more')
  })

  it('shows both when the label is not the destination (www. autolink)', () => {
    expect(visible('go to www.example.com now')).toContain(
      'www.example.com (http://www.example.com)'
    )
  })

  it('leaves no anchor and nothing executable for a javascript: link', () => {
    const dom = parse(
      '[click](javascript:window.__pwned=1) and [also](JaVaScRiPt:alert(1))'
    )
    expect(dom.querySelector('a')).toBeNull()
    for (const el of dom.querySelectorAll('*')) {
      expect(
        el.getAttributeNames().filter(n => /^(on|href|src)/i.test(n))
      ).toEqual([])
    }
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('keeps the label of an anchor that sanitizing left without a destination', () => {
    // A data: link keeps its text; whatever DOMPurify strips, no anchor stays.
    const dom = parse('[label](data:text/html;base64,PHNjcmlwdD4=)')
    expect(dom.querySelector('a')).toBeNull()
    expect(dom.textContent).toContain('label')
  })

  it('does not let a link label inject markup', () => {
    const dom = parse('[<img src=x onerror=1>](https://e.example)')
    expect(dom.querySelector('img')).toBeNull()
    expect(dom.querySelector('[onerror]')).toBeNull()
    expect(dom.textContent).toContain('https://e.example')
  })

  it('still renders code, lists, quotes and emphasis', () => {
    const dom = parse(
      [
        '**bold** and `inline`',
        '',
        '- one',
        '- two',
        '',
        '> quoted',
        '',
        '```',
        'block',
        '```',
      ].join('\n')
    )
    expect(dom.querySelector('strong')?.textContent).toBe('bold')
    expect(dom.querySelector('code')?.textContent).toBe('inline')
    expect(dom.querySelectorAll('li')).toHaveLength(2)
    expect(dom.querySelector('blockquote')?.textContent).toContain('quoted')
    expect(dom.querySelector('pre')?.textContent).toContain('block')
  })

  it('leaves a URL inside code alone', () => {
    const dom = parse('run `curl https://example.com/x` now')
    expect(dom.querySelector('code')?.textContent).toBe(
      'curl https://example.com/x'
    )
  })

  it('does not touch the live document while parsing', () => {
    const before = document.body.innerHTML
    renderAgentHtml('[a](https://e.example) <img src=x onerror=1>')
    expect(document.body.innerHTML).toBe(before)
  })

  it('removes every image, so hiding one never rests on CSS', () => {
    const dom = parse(
      '{attachment:9} and <img src=x onerror=1> and ![r](https://evil.example/p.png)'
    )
    expect(dom.querySelectorAll('img')).toHaveLength(0)
    expect(dom.querySelector('[onerror]')).toBeNull()
  })

  it('keeps a heading as a heading', () => {
    const dom = parse('# One\n\n## Two\n\n###### Six\n\nbody')
    expect(dom.querySelector('h1')?.textContent).toBe('One')
    expect(dom.querySelector('h2')?.textContent).toBe('Two')
    expect(dom.querySelector('h6')?.textContent).toBe('Six')
  })

  it('keeps the header row and the cells of a table', () => {
    const dom = parse(
      '| Planet | Moons |\n| --- | --- |\n| Mercury | 0 |\n| Venus | 0 |'
    )
    expect(
      [...dom.querySelectorAll('thead th')].map(cell => cell.textContent)
    ).toEqual(['Planet', 'Moons'])
    expect(
      [...dom.querySelectorAll('tbody tr')].map(tr =>
        [...tr.querySelectorAll('td')].map(cell => cell.textContent)
      )
    ).toEqual([
      ['Mercury', '0'],
      ['Venus', '0'],
    ])
  })

  it('drops the alignment style a :---: column carries', () => {
    const dom = parse('| a | b |\n| :---: | ---: |\n| 1 | 2 |')
    expect(dom.querySelectorAll('th')).toHaveLength(2)
    expect(dom.querySelector('[style]')).toBeNull()
  })

  it('still writes out the address of a link in a table cell or a heading', () => {
    const dom = parse(
      '## See [docs](https://e.example/x)\n\n| a |\n| --- |\n| [go](https://e.example/y) |'
    )
    expect(dom.querySelector('a')).toBeNull()
    expect(dom.querySelector('h2')?.textContent).toBe(
      'See docs (https://e.example/x)'
    )
    expect(dom.querySelector('td')?.textContent).toBe(
      'go (https://e.example/y)'
    )
  })

  it('still removes an image in a table cell', () => {
    const dom = parse(
      '| a |\n| --- |\n| {attachment:9} <img src=x onerror=1> |'
    )
    expect(dom.querySelector('td')).not.toBeNull()
    expect(dom.querySelectorAll('img')).toHaveLength(0)
    expect(dom.querySelector('[onerror]')).toBeNull()
  })

  it('keeps the existing guarantees: no script, no event handler, no image source', () => {
    const dom = parse(
      '<img src=x onerror="window.__pwned=2">\n\n<script>window.__pwned=3</script>\n\n![r](https://evil.example/p.png)'
    )
    expect(dom.querySelector('script')).toBeNull()
    expect(dom.querySelector('[onerror]')).toBeNull()
    for (const img of dom.querySelectorAll('img')) {
      expect(img).not.toHaveAttribute('src')
    }
  })
})
