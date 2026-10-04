/**
 * Undo what the viewer added before a serialized document is saved (spec §7.4):
 * the injection block, the bridge script tag, the theme stamp, and the editable
 * attribute. The bridge strips its own overlay nodes and minted heading ids;
 * both sides strip so a miss on one side cannot leak viewer markup into a revision.
 */
export const INJECT_OPEN = '<!--pn-inject-->'
export const INJECT_CLOSE = '<!--/pn-inject-->'
const BRIDGE_SCRIPT_TAG =
  /<script\b[^>]*\bsrc=["'][^"']*\/pn-bridge\.v\d+\.js["'][^>]*>\s*<\/script>/gi
const HTML_DATA_THEME = /(<html\b[^>]*?)\s+data-theme=(["'])([^"']*)\2/i

export function stripViewerInjection(html: string, original: string): string {
  let out = html
  const a = out.indexOf(INJECT_OPEN)
  const b = out.indexOf(INJECT_CLOSE)
  if (a !== -1 && b > a)
    out = out.slice(0, a) + out.slice(b + INJECT_CLOSE.length)
  out = out.replace(BRIDGE_SCRIPT_TAG, '')
  const authored = original.match(HTML_DATA_THEME)?.[3]
  out = out.replace(HTML_DATA_THEME, (_m, before: string, q: string) =>
    authored === undefined ? before : `${before} data-theme=${q}${authored}${q}`
  )
  out = out.replace(/\s+contenteditable=(["'])[^"']*\1/gi, '')
  return out
}
