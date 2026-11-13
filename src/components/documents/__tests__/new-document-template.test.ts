import { describe, expect, it } from 'vitest'
import {
  MAX_DOCUMENT_BYTES,
  checkHtmlFile,
  starterHtml,
} from '@/components/documents/new-document-template'

describe('starterHtml', () => {
  it('is a complete document with a head (the server inlines the theme there) and the title twice', () => {
    const html = starterHtml('Balance SOP')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toMatch(
      /<head>[\s\S]*<title>Balance SOP<\/title>[\s\S]*<\/head>/
    )
    expect(html).toContain('<h1>Balance SOP</h1>')
    expect(html).not.toContain('accumark-docs')
  })

  it('escapes markup in the title', () => {
    const html = starterHtml('<b>x</b> & "y"')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;')
  })
})

describe('checkHtmlFile', () => {
  it('accepts a document whose first non-blank byte is <, BOM allowed', () => {
    expect(checkHtmlFile('﻿ \n<!doctype html><p>a</p>')).toBeNull()
  })
  it('rejects text that is not an HTML document', () => {
    expect(checkHtmlFile('# Markdown title')).toMatch(/not an HTML document/)
    expect(checkHtmlFile('')).toMatch(/not an HTML document/)
  })
  it('rejects a file over the server limit', () => {
    const big = '<p>' + 'x'.repeat(MAX_DOCUMENT_BYTES) + '</p>'
    expect(checkHtmlFile(big)).toMatch(/16 MB/)
  })
})
