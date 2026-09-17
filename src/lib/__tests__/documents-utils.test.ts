import { describe, expect, it } from 'vitest'
import {
  buildDocumentListQuery,
  documentDownloadName,
  formatDocDate,
  resolveDocTheme,
  stampDocumentTheme,
} from '@/components/documents/documents-utils'

describe('buildDocumentListQuery', () => {
  it('uses the defaults: draft+active, updated_at, page 1, 50 per page', () => {
    const q = new URLSearchParams(buildDocumentListQuery({}))
    expect(q.getAll('status')).toEqual(['draft', 'active'])
    expect(q.get('sort')).toBe('updated_at')
    expect(q.get('page')).toBe('1')
    expect(q.get('page_size')).toBe('50')
    expect(q.has('q')).toBe(false)
    expect(q.has('category_id')).toBe(false)
  })

  it('carries search, category, statuses, sort and paging', () => {
    const q = new URLSearchParams(
      buildDocumentListQuery({
        q: '  audit ',
        categoryId: 3,
        statuses: ['retired'],
        sort: 'title',
        page: 2,
        pageSize: 25,
      })
    )
    expect(q.get('q')).toBe('audit')
    expect(q.get('category_id')).toBe('3')
    expect(q.getAll('status')).toEqual(['retired'])
    expect(q.get('sort')).toBe('title')
    expect(q.get('page')).toBe('2')
    expect(q.get('page_size')).toBe('25')
  })

  it('drops a blank search and a null category', () => {
    const q = new URLSearchParams(
      buildDocumentListQuery({ q: '   ', categoryId: null })
    )
    expect(q.has('q')).toBe(false)
    expect(q.has('category_id')).toBe(false)
  })
})

describe('resolveDocTheme', () => {
  it('passes explicit themes through and resolves system from the media query', () => {
    expect(resolveDocTheme('dark', false)).toBe('dark')
    expect(resolveDocTheme('light', true)).toBe('light')
    expect(resolveDocTheme('system', true)).toBe('dark')
    expect(resolveDocTheme('system', false)).toBe('light')
  })
})

describe('stampDocumentTheme', () => {
  it('adds data-theme to an unstamped <html>', () => {
    expect(
      stampDocumentTheme(
        '<!doctype html><html lang="en"><body>x</body></html>',
        'dark'
      )
    ).toBe(
      '<!doctype html><html data-theme="dark" lang="en"><body>x</body></html>'
    )
  })
  it('replaces an existing data-theme', () => {
    expect(
      stampDocumentTheme("<html data-theme='light'><body/></html>", 'dark')
    ).toBe("<html data-theme='dark'><body/></html>")
  })
  it('wraps a bare fragment', () => {
    const out = stampDocumentTheme('<p>hi</p>', 'light')
    expect(out.startsWith('<!doctype html><html data-theme="light">')).toBe(
      true
    )
    expect(out).toContain('<p>hi</p>')
  })
})

describe('formatting helpers', () => {
  it('formats dates as YYYY-MM-DD or a dash', () => {
    expect(formatDocDate('2026-09-15T21:26:27')).toBe('2026-09-15')
    expect(formatDocDate('2026-09-15')).toBe('2026-09-15')
    expect(formatDocDate(null)).toBe('—')
    expect(formatDocDate(undefined)).toBe('—')
  })
  it('names downloads by code and revision', () => {
    expect(documentDownloadName('ART-0012', 3)).toBe('ART-0012-r3.html')
  })
})
