/** Compose + render helpers for @mentions. All pure. */

/** The open `@token` immediately before the caret, or null. A token runs from an
 *  `@` (at string start or after whitespace) up to the caret, and closes on any
 *  whitespace. */
export function activeMentionQuery(
  value: string,
  caret: number
): { query: string; start: number } | null {
  const upto = value.slice(0, caret)
  const at = upto.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(upto[at - 1] ?? '')) return null
  const query = upto.slice(at + 1)
  if (/\s/.test(query)) return null
  return { query, start: at }
}

/** Ids from `selected` whose `@name` text is still present in the body. */
export function mentionIdsInBody(
  body: string,
  selected: Map<number, string>
): number[] {
  const out: number[] = []
  for (const [id, name] of selected) {
    if (body.includes(`@${name}`)) out.push(id)
  }
  return out
}

/** Split a body into plain-text + mention segments for rendering. Longest names
 *  first so overlapping names match greedily. */
export function renderCommentSegments(
  body: string,
  mentions: number[],
  nameOf: (id: number) => string
): { text: string; mentionId: number | null }[] {
  const tokens = mentions
    .map(id => ({ id, tok: `@${nameOf(id)}` }))
    .sort((a, b) => b.tok.length - a.tok.length)
  const segs: { text: string; mentionId: number | null }[] = []
  let i = 0
  while (i < body.length) {
    const hit = tokens.find(t => body.startsWith(t.tok, i))
    if (hit) {
      segs.push({ text: hit.tok, mentionId: hit.id })
      i += hit.tok.length
    } else {
      const last = segs[segs.length - 1]
      if (last && last.mentionId === null) last.text += body[i]
      else segs.push({ text: body[i] ?? '', mentionId: null })
      i += 1
    }
  }
  return segs
}
