/**
 * Pure helpers for the Documents library UI. No React, no fetch — everything
 * here is unit-tested in src/lib/__tests__/documents-utils.test.ts.
 */

export type DocumentStatus = 'draft' | 'active' | 'retired'
export type DocumentSort = 'updated_at' | 'title' | 'code' | 'effective_date'
export type DocTheme = 'dark' | 'light'

export interface DocumentListParams {
  q?: string
  categoryId?: number | null
  statuses?: DocumentStatus[]
  sort?: DocumentSort
  page?: number
  pageSize?: number
}

export const DEFAULT_STATUSES: DocumentStatus[] = ['draft', 'active']

export const DOC_STATUS_LABEL: Record<DocumentStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  retired: 'Retired',
}

/** Query string for GET /api/documents (spec §5.1). */
export function buildDocumentListQuery(p: DocumentListParams): string {
  const params = new URLSearchParams()
  const q = p.q?.trim()
  if (q) params.set('q', q)
  if (p.categoryId != null) params.set('category_id', String(p.categoryId))
  for (const s of p.statuses ?? DEFAULT_STATUSES) params.append('status', s)
  params.set('sort', p.sort ?? 'updated_at')
  params.set('page', String(p.page ?? 1))
  params.set('page_size', String(p.pageSize ?? 50))
  return params.toString()
}

/** Mk1's useTheme() can return 'system'; the frame needs a concrete mode. */
export function resolveDocTheme(
  theme: 'dark' | 'light' | 'system',
  prefersDark: boolean
): DocTheme {
  return theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme
}

/**
 * Stamp Mk1's theme onto the document root so the artifact CSS
 * (`:root[data-theme="dark"]`) follows the app toggle instead of the OS.
 */
export function stampDocumentTheme(html: string, mode: DocTheme): string {
  if (/<html\b[^>]*\sdata-theme=/i.test(html)) {
    return html.replace(
      /(<html\b[^>]*\sdata-theme=)(["'])[^"']*\2/i,
      (_m, before: string, quote: string) => `${before}${quote}${mode}${quote}`
    )
  }
  if (/<html\b/i.test(html)) {
    return html.replace(/<html\b/i, `<html data-theme="${mode}"`)
  }
  return `<!doctype html><html data-theme="${mode}"><head><meta charset="utf-8"></head><body>${html}</body></html>`
}

export function formatDocDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '—'
}

export function documentDownloadName(code: string, revision: number): string {
  return `${code}-r${revision}.html`
}
