/** Mirrors backend/documents/service.py MAX_BYTES (checked after theming there). */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A blank page to edit. No theme: the server inlines the house theme into
 *  <head> on save, which is why the head must exist. */
export function starterHtml(title: string): string {
  const t = escapeHtml(title.trim())
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${t}</title>`,
    '</head>',
    '<body>',
    `<h1>${t}</h1>`,
    '<p>Start writing here.</p>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/** Client-side mirror of validate_html: null when acceptable, else the reason. */
export function checkHtmlFile(text: string): string | null {
  if (text.replace(/^\uFEFF/, '').trimStart()[0] !== '<') {
    return 'That file is not an HTML document (it must start with a tag)'
  }
  if (new TextEncoder().encode(text).length > MAX_DOCUMENT_BYTES) {
    return 'That file exceeds the 16 MB document limit'
  }
  return null
}
