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
