/**
 * Undo what the viewer added before a serialized document is saved (spec §7.4):
 * the injection block, the bridge script tag, the theme stamp, and the editable
 * attribute. The bridge strips its own overlay nodes and minted heading ids;
 * both sides strip so a miss on one side cannot leak viewer markup into a revision.
 * It also restores any author CSP `<meta>` the viewer neutralized for display.
 */
import { META_CSP_PLACEHOLDER, META_CSP_RE } from '@/vendor/plannotator/srcdoc'

export const INJECT_OPEN = '<!--pn-inject-->'
export const INJECT_CLOSE = '<!--/pn-inject-->'
const BRIDGE_SCRIPT_TAG =
  /<script\b[^>]*\bsrc=["'][^"']*\/pn-bridge\.v\d+\.js["'][^>]*>\s*<\/script>/gi
const HTML_DATA_THEME =
  /(<html\b[^>]*?)\s+data-theme=(?:(["'])([^"']*)\2|([^\s>"']+))/i
const BODY_TAG = /<body\b[^>]*>/i
const CONTENTEDITABLE_ATTR =
  /\s+contenteditable(?:=(?:"[^"]*"|'[^']*'|[^\s>"']+))?/gi

export function stripViewerInjection(html: string, original: string): string {
  let out = html
  // The viewer injects immediately before </head> (or prepends with no head), so
  // the real block is the LAST open marker before </head>. Author text that
  // happens to contain a marker elsewhere is never touched.
  const headClose = out.indexOf('</head>')
  const a =
    headClose === -1
      ? out.lastIndexOf(INJECT_OPEN)
      : out.lastIndexOf(INJECT_OPEN, headClose)
  const b = a === -1 ? -1 : out.indexOf(INJECT_CLOSE, a)
  if (a !== -1 && b > a)
    out = out.slice(0, a) + out.slice(b + INJECT_CLOSE.length)
  out = out.replace(BRIDGE_SCRIPT_TAG, '')
  const m = original.match(HTML_DATA_THEME)
  const authored = m ? (m[3] ?? m[4]) : undefined
  out = out.replace(HTML_DATA_THEME, (_m, before: string) => {
    if (!m || authored === undefined) return before
    // Restore the author's own quoting (m[2] is undefined for an unquoted value).
    const q = m[2] ?? ''
    return `${before} data-theme=${q}${authored}${q}`
  })
  // Only the <body> start tag: the sole element the viewer makes editable.
  out = out.replace(BODY_TAG, tag => tag.replace(CONTENTEDITABLE_ATTR, ''))
  // Every placeholder in the output, in document order, is either an author
  // CSP tag the viewer swapped out or an author's own literal placeholder
  // text; both come back from the original bytes, and a placeholder with no
  // original left is dropped. Split, not a replace string, so `$&` in an
  // author policy is never expanded.
  const restore = cspRestoreList(original)
  return out
    .split(META_CSP_PLACEHOLDER)
    .reduce((acc, part, k) => acc + (restore[k - 1] ?? '') + part)
}

function cspRestoreList(original: string): string[] {
  const found: [number, string][] = [...original.matchAll(META_CSP_RE)].map(
    m => [m.index, m[0]]
  )
  for (
    let at = original.indexOf(META_CSP_PLACEHOLDER);
    at !== -1;
    at = original.indexOf(META_CSP_PLACEHOLDER, at + 1)
  )
    found.push([at, META_CSP_PLACEHOLDER])
  return found.sort((a, b) => a[0] - b[0]).map(f => f[1])
}
