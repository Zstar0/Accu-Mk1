/**
 * Shape-checking for messages from the sandboxed document frame (spec §7.3).
 * The frame is untrusted content: everything is validated and capped here,
 * anchors through the vendored upstream validators, before the app sees it.
 */
import {
  parseHtmlElementAnchor,
  parseHtmlElementContext,
  type HtmlElementAnchor,
  type HtmlElementContext,
} from '@/vendor/plannotator/html-anchor'

export const PN = 'plannotator-bridge-'
export const MAX_SELECTION_TEXT = 10_000
export const MAX_ID = 256
export const MAX_HEADINGS = 500
export const MAX_HEADING_TEXT = 130
export const MAX_SERIALIZED = 16 * 1024 * 1024
export const MIN_FRAME_HEIGHT = 200
export const MAX_FRAME_HEIGHT = 50_000

export interface Rect {
  top: number
  left: number
  width: number
  height: number
}
export interface BridgeHeading {
  id: string
  level: number
  text: string
}
export interface BridgeSelection {
  text: string
  rect: Rect
  anchor: HtmlElementAnchor | null
  context: HtmlElementContext | null
  pinpoint: boolean
  targetLabel?: string
  targetKey?: string
}

export type ParsedBridgeMessage =
  | { type: 'ready'; protocolVersion: number | undefined }
  | { type: 'selection'; selection: BridgeSelection }
  | { type: 'selection-rect'; rect: Rect }
  | { type: 'selection-clear' }
  | { type: 'mark-click'; id: string }
  | { type: 'mark-applied'; id: string; success: boolean }
  | { type: 'unanchored'; ids: string[] }
  | { type: 'resize'; height: number }
  | { type: 'link-click'; href: string }
  | { type: 'headings'; headings: BridgeHeading[] }
  | { type: 'serialized'; html: string; appliedId?: string }
  | { type: 'apply-failed'; id: string }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null
const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

function rect(v: unknown): Rect | null {
  if (!isRecord(v)) return null
  const top = num(v.top)
  const left = num(v.left)
  const width = num(v.width)
  const height = num(v.height)
  if (top === null || left === null || width === null || height === null)
    return null
  return { top, left, width, height }
}

/** Returns null for anything unknown, malformed, or over a cap. */
export function parseBridgeMessage(data: unknown): ParsedBridgeMessage | null {
  if (
    !isRecord(data) ||
    typeof data.type !== 'string' ||
    !data.type.startsWith(PN)
  )
    return null
  const type = data.type.slice(PN.length)
  switch (type) {
    case 'ready':
      return { type, protocolVersion: num(data.protocolVersion) ?? undefined }
    case 'selection': {
      const text =
        typeof data.text === 'string' && data.text.length <= MAX_SELECTION_TEXT
          ? data.text
          : null
      const r = rect(data.rect)
      if (text === null || !r) return null
      return {
        type,
        selection: {
          text,
          rect: r,
          anchor: parseHtmlElementAnchor(data.anchor) ?? null,
          context: parseHtmlElementContext(data.context) ?? null,
          pinpoint: data.pinpoint === true,
          targetLabel: str(data.targetLabel, 64) ?? undefined,
          targetKey: str(data.targetKey, MAX_ID) ?? undefined,
        },
      }
    }
    case 'selection-rect': {
      const r = rect(data.rect)
      return r ? { type, rect: r } : null
    }
    case 'selection-clear':
      return { type }
    case 'mark-click': {
      const id = str(data.id, MAX_ID)
      return id ? { type, id } : null
    }
    case 'mark-applied': {
      const id = str(data.id, MAX_ID)
      return id ? { type, id, success: data.success === true } : null
    }
    case 'unanchored': {
      if (!Array.isArray(data.ids) || data.ids.length > 10_000) return null
      const ids = data.ids.filter(
        (x): x is string =>
          typeof x === 'string' && x.length > 0 && x.length <= MAX_ID
      )
      return { type, ids }
    }
    case 'resize': {
      const h = num(data.height)
      if (h === null) return null
      return {
        type,
        height: Math.min(
          MAX_FRAME_HEIGHT,
          Math.max(MIN_FRAME_HEIGHT, Math.round(h))
        ),
      }
    }
    case 'link-click': {
      const href = str(data.href, 2048)
      return href ? { type, href } : null
    }
    case 'headings': {
      if (!Array.isArray(data.headings) || data.headings.length > MAX_HEADINGS)
        return null
      const headings: BridgeHeading[] = []
      for (const h of data.headings) {
        if (!isRecord(h)) return null
        const id = str(h.id, MAX_ID)
        const level = num(h.level)
        const text =
          typeof h.text === 'string' && h.text.length <= MAX_HEADING_TEXT
            ? h.text
            : null
        if (!id || level === null || level < 1 || level > 6 || text === null)
          return null
        headings.push({ id, level, text })
      }
      return { type, headings }
    }
    case 'serialized': {
      const html =
        typeof data.html === 'string' && data.html.length <= MAX_SERIALIZED
          ? data.html
          : null
      if (html === null) return null
      return { type, html, appliedId: str(data.appliedId, MAX_ID) ?? undefined }
    }
    case 'apply-failed': {
      const id = str(data.id, MAX_ID)
      return id ? { type, id } : null
    }
    default:
      return null
  }
}
