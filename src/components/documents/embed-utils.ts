/**
 * Pure helpers for the read-only embed shell (DocumentEmbed.tsx). A separate
 * module so the component file exports only components (react-refresh).
 */
import type { DocumentDetail } from '@/lib/api-documents'
import { stampDocumentTheme } from './documents-utils'

export interface EmbedRef {
  id: number
  code: string
  rev: number
  sha: string
}

const CODE_RE = /^(?=.{3,30}$)[A-Z0-9]+-[A-Z0-9-]+$/ // mirrors backend documents.service.CODE_RE
const SHA_RE = /^[0-9a-f]{64}$/

export function parseEmbedRef(hash: string): EmbedRef | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''))
  const id = Number(p.get('id'))
  const rev = Number(p.get('rev'))
  const code = p.get('code') ?? ''
  const sha = p.get('sha') ?? ''
  if (!Number.isSafeInteger(id) || id <= 0) return null
  if (!Number.isSafeInteger(rev) || rev <= 0) return null
  if (!CODE_RE.test(code) || !SHA_RE.test(sha)) return null
  return { id, code, rev, sha }
}

/**
 * CSP for the document frame, on top of the policy it inherits from the shell.
 * Inline scripts/styles stay (charts, theme); every network fetch is denied
 * except the theme's Google Fonts. No forms, no base rewrites.
 */
export const EMBED_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"

export function buildEmbedSrcDoc(html: string, mode: 'light' | 'dark'): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${EMBED_FRAME_CSP}">`
  const stamped = stampDocumentTheme(html, mode)
  // The meta must precede any document content to govern it.
  const head = /<head\b[^>]*>/i.exec(stamped)
  if (head)
    return (
      stamped.slice(0, head.index + head[0].length) +
      meta +
      stamped.slice(head.index + head[0].length)
    )
  return stamped.replace(/<html\b[^>]*>/i, m => `${m}<head>${meta}</head>`)
}

export function refMismatch(ref: EmbedRef, doc: DocumentDetail): boolean {
  return (
    doc.id !== ref.id ||
    doc.code !== ref.code ||
    doc.revision !== ref.rev ||
    doc.content_sha256 !== ref.sha
  )
}
