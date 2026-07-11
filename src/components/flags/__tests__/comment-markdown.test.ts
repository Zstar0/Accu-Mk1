import { describe, expect, it } from 'vitest'
import { renderCommentHtml } from '@/components/flags/comment-markdown'

const M = [{ id: 7, tok: '@Ann Lee' }]

describe('renderCommentHtml', () => {
  it('plain text renders unchanged (superset claim)', () => {
    expect(renderCommentHtml('just a note', [])).toContain('just a note')
  })
  it('bold/italic/inline-code/lists render', () => {
    const h = renderCommentHtml('**b** _i_ `c`\n\n- one\n- two', [])
    expect(h).toMatch(/<strong>b<\/strong>/)
    expect(h).toMatch(/<em>i<\/em>/)
    expect(h).toMatch(/<code>c<\/code>/)
    expect(h).toMatch(/<li>one<\/li>/)
  })
  it('fenced code block renders', () => {
    expect(renderCommentHtml('```\nx=1\n```', [])).toMatch(/<pre>/)
  })
  it('linkifies bare URLs with hardened rel/target', () => {
    const h = renderCommentHtml('see http://example.com now', [])
    expect(h).toMatch(/<a[^>]+href="http:\/\/example\.com"/)
    expect(h).toMatch(/target="_blank"/)
    expect(h).toMatch(/rel="[^"]*noopener/)
  })
  it('escapes raw HTML (no injection)', () => {
    const h = renderCommentHtml('<script>alert(1)</script>', [])
    expect(h).not.toContain('<script>')
  })
  it('does NOT render markdown image syntax', () => {
    const h = renderCommentHtml('![x](http://evil/p.png)', [])
    expect(h).not.toMatch(/<img[^>]+src=/)
  })
  it('renders a mention as a highlighted span', () => {
    const h = renderCommentHtml('hi @Ann Lee', M)
    expect(h).toMatch(/<span class="flag-mention">@Ann Lee<\/span>/)
  })
  it('leaves @name literal inside inline code', () => {
    const h = renderCommentHtml('`@Ann Lee`', M)
    expect(h).toMatch(/<code>@Ann Lee<\/code>/)
    expect(h).not.toContain('flag-mention')
  })
  it('renders an attachment token as a src-less img', () => {
    // DOMPurify may reorder attributes, so assert presence, not order.
    const h = renderCommentHtml('shot {attachment:12}', [])
    expect(h).toMatch(/<img[^>]*class="flag-attach"/)
    expect(h).toMatch(/data-attachment-id="12"/)
    expect(h).not.toMatch(/<img[^>]+src=/)
  })
  it('neutralizes a javascript: link href (no active href)', () => {
    // markdown-it's validateLink rejects the URL (inert text); DOMPurify also
    // strips javascript: hrefs. Either way, no executable href survives.
    const h = renderCommentHtml('[x](javascript:alert(1))', [])
    expect(h).not.toMatch(/href\s*=\s*["']?javascript:/i)
  })
})
