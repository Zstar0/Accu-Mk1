/**
 * Markdown-lite comment renderer (spec §6). A sanitizing pipeline:
 * markdown-it (html:false, linkify:true, image rule disabled) → a core rule
 * that swaps @mention + {attachment:ID} tokens ONLY on `text` tokens (code
 * spans/fences are distinct token types, so their contents stay literal — this
 * is the authoritative resolution of the spec's "mentions parse before markdown
 * so @name in code stays literal": the goal wins) → DOMPurify backstop.
 */
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

// `@types/markdown-it` uses `export = MarkdownIt`, so the default import is a
// value (not a namespace qualifier). Derive the token/state types from the
// instance type instead of `MarkdownIt.StateCore` (which doesn't resolve here).
type StateCore = Parameters<
  Parameters<MarkdownIt['core']['ruler']['push']>[1]
>[0]
type Token = StateCore['tokens'][number]

export interface MentionToken {
  id: number
  /** The literal `@Display Name` string to match in the body. */
  tok: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const ATTACHMENT_RE = /^\{attachment:(\d+)\}/

/** Split one `text` token into text + injected html_inline (mention/attachment)
 *  tokens. Mentions are matched longest-first so overlapping names win greedily
 *  (mirrors renderCommentSegments in mention-parse.ts). */
function splitTextToken(
  state: StateCore,
  src: Token,
  mentions: MentionToken[]
): Token[] {
  const body = src.content
  const out: Token[] = []
  let buf = ''
  const flush = () => {
    if (!buf) return
    const t = new state.Token('text', '', 0)
    t.content = buf
    out.push(t)
    buf = ''
  }
  const pushHtml = (html: string) => {
    flush()
    const t = new state.Token('html_inline', '', 0)
    t.content = html
    out.push(t)
  }
  let i = 0
  while (i < body.length) {
    const attach = body.slice(i).match(ATTACHMENT_RE)
    if (attach) {
      pushHtml(
        `<img class="flag-attach" data-attachment-id="${attach[1]}" alt="attachment">`
      )
      i += attach[0].length
      continue
    }
    const hit = mentions.find(m => body.startsWith(m.tok, i))
    if (hit) {
      pushHtml(`<span class="flag-mention">${escapeHtml(hit.tok)}</span>`)
      i += hit.tok.length
      continue
    }
    buf += body[i]
    i += 1
  }
  flush()
  return out
}

function flagTokenPlugin(md: MarkdownIt): void {
  md.core.ruler.push('flag_tokens', (state: StateCore) => {
    const env = (state.env ?? {}) as { mentionTokens?: MentionToken[] }
    const mentions = [...(env.mentionTokens ?? [])].sort(
      (a, b) => b.tok.length - a.tok.length
    )
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue
      const next: Token[] = []
      for (const child of block.children) {
        if (child.type === 'text')
          next.push(...splitTextToken(state, child, mentions))
        else next.push(child) // code_inline / link / etc. — never touched
      }
      block.children = next
    }
    return true
  })
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
md.disable('image') // no markdown image syntax — images come from attachments

// Harden every link: open in a new tab, drop referrer + window.opener.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const t = tokens[idx]
  if (t) {
    t.attrSet('target', '_blank')
    t.attrSet('rel', 'noopener noreferrer')
  }
  return defaultLinkOpen(tokens, idx, options, env, self)
}
md.use(flagTokenPlugin)

/** Render markdown-lite comment body → sanitized HTML string. */
export function renderCommentHtml(
  body: string,
  mentionTokens: MentionToken[]
): string {
  const raw = md.render(body ?? '', { mentionTokens })
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      'p',
      'br',
      'hr',
      'strong',
      'em',
      'b',
      'i',
      'code',
      'pre',
      'ul',
      'ol',
      'li',
      'a',
      'blockquote',
      'span',
      'img',
    ],
    // NOTE: no custom ALLOWED_URI_REGEXP — it would be applied to `target`/`rel`
    // too and strip the link hardening set above. DOMPurify's default URI filter
    // already neutralizes javascript:/data: on href (verified in tests). Injected
    // attachment imgs carry no src here; a CommentBody effect sets the blob URL.
    ALLOWED_ATTR: [
      'href',
      'target',
      'rel',
      'class',
      'data-attachment-id',
      'alt',
    ],
  })
}
