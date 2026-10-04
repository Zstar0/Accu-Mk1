/**
 * Parent side of the document frame protocol (spec §7.3). One listener, one
 * trust boundary: a message is handled only when it comes from THIS iframe's
 * window with the null origin a sandboxed srcdoc has, and parses cleanly.
 * Nothing here touches contentDocument; it cannot, and the design depends on
 * that staying true.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { BRIDGE_PROTOCOL_VERSION } from '@/vendor/plannotator/bridge-script'
import type { HtmlElementAnchor } from '@/vendor/plannotator/html-anchor'
import {
  MIN_FRAME_HEIGHT,
  PN,
  parseBridgeMessage,
  type BridgeHeading,
  type BridgeSelection,
  type Rect,
} from './bridge-messages'

export type { BridgeHeading, BridgeSelection, Rect } from './bridge-messages'

export interface BridgeComment {
  id: string
  type: 'comment' | 'deletion'
  originalText: string
  anchor: HtmlElementAnchor | null
  additionalAnchors: HtmlElementAnchor[] | null
  number: number
}
export type BridgeStatus = 'loading' | 'ready' | 'unavailable'
export interface BridgeUnavailable {
  kind: 'timeout' | 'version-mismatch'
  reported?: number
}
export interface UseDocumentBridgeOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>
  /** Changes whenever a new srcDoc loads; resets the handshake. */
  documentKey: string | number
  comments: BridgeComment[]
  inputMethod: 'drag' | 'pinpoint'
  annotateActive: boolean
  onSelection: (s: BridgeSelection | null) => void
  onSelectionRect?: (r: Rect) => void
  onMarkClick: (id: string) => void
  onSerialized?: (html: string, appliedId?: string) => void
  onApplyFailed?: (id: string) => void
  readyTimeoutMs?: number
}
export interface DocumentBridge {
  status: BridgeStatus
  unavailable: BridgeUnavailable | null
  headings: BridgeHeading[]
  unanchoredIds: ReadonlySet<string>
  height: number
  createMark: (id: string, type: 'comment' | 'deletion') => void
  cancelSelection: () => void
  removeMark: (id: string) => void
  scrollTo: (id: string) => void
  scrollToFragment: (id: string) => void
  setEditMode: (on: boolean) => void
  serialize: () => void
  applyReplacement: (id: string, text: string) => void
}

/** Only http(s), always in a new tab with no opener (spec §11). */
export function openDocumentLink(
  href: string,
  open: (url: string) => void = url => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
) {
  if (/^https?:\/\//i.test(href)) open(href)
}

export function useDocumentBridge(
  options: UseDocumentBridgeOptions
): DocumentBridge {
  const [status, setStatus] = useState<BridgeStatus>('loading')
  const [unavailable, setUnavailable] = useState<BridgeUnavailable | null>(null)
  const [headings, setHeadings] = useState<BridgeHeading[]>([])
  const [unanchoredIds, setUnanchored] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [height, setHeight] = useState(MIN_FRAME_HEIGHT)
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })

  const post = useCallback((msg: Record<string, unknown>) => {
    // '*' is required: a sandboxed srcdoc frame has an opaque origin, which no
    // concrete targetOrigin can name. The frame holds no secrets of ours.
    latest.current.iframeRef.current?.contentWindow?.postMessage(msg, '*')
  }, [])

  const replay = useCallback(() => {
    const { comments, inputMethod, annotateActive } = latest.current
    post({ type: `${PN}set-input-method`, method: inputMethod })
    post({ type: `${PN}set-annotate-mode`, active: annotateActive })
    post({ type: `${PN}clear-marks` })
    for (const c of comments) {
      post({
        type: `${PN}find-and-mark`,
        id: c.id,
        annotationType: c.type,
        originalText: c.originalText,
        anchor: c.anchor ?? undefined,
        additionalAnchors: c.additionalAnchors ?? undefined,
      })
    }
    post({
      type: `${PN}sync-annotations`,
      annotations: comments.map(c => ({ id: c.id, number: c.number })),
    })
    post({ type: `${PN}report-unanchored` })
  }, [post])

  // A new document: start the handshake over. Adjusting state during render
  // (not in an effect) is the React-sanctioned pattern for resetting on a key change.
  const [seenKey, setSeenKey] = useState(options.documentKey)
  if (seenKey !== options.documentKey) {
    setSeenKey(options.documentKey)
    setStatus('loading')
    setUnavailable(null)
    setHeadings([])
    setUnanchored(new Set())
  }

  // No ready within the timeout: the document renders without tools (spec §7.2).
  useEffect(() => {
    if (status !== 'loading') return
    const t = setTimeout(() => {
      setStatus('unavailable')
      setUnavailable({ kind: 'timeout' })
    }, options.readyTimeoutMs ?? 8000)
    return () => clearTimeout(t)
  }, [status, options.documentKey, options.readyTimeoutMs])

  // The trust boundary.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = latest.current.iframeRef.current
      if (
        !frame ||
        !frame.contentWindow ||
        e.source !== frame.contentWindow ||
        e.origin !== 'null'
      )
        return
      const m = parseBridgeMessage(e.data)
      if (!m) return
      switch (m.type) {
        case 'ready':
          if (m.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
            setStatus('unavailable')
            setUnavailable({
              kind: 'version-mismatch',
              reported: m.protocolVersion,
            })
            return
          }
          setStatus('ready')
          setUnavailable(null)
          replay()
          return
        case 'selection':
          latest.current.onSelection(m.selection)
          return
        case 'selection-rect':
          latest.current.onSelectionRect?.(m.rect)
          return
        case 'selection-clear':
          latest.current.onSelection(null)
          return
        case 'mark-click':
          latest.current.onMarkClick(m.id)
          return
        case 'unanchored':
          setUnanchored(new Set(m.ids))
          return
        case 'resize':
          setHeight(m.height)
          return
        case 'link-click':
          openDocumentLink(m.href)
          return
        case 'headings':
          setHeadings(m.headings)
          return
        case 'serialized':
          latest.current.onSerialized?.(m.html, m.appliedId)
          return
        case 'apply-failed':
          latest.current.onApplyFailed?.(m.id)
          return
        default:
          return
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [replay])

  // Re-sync marks when the comment set or the mode changes.
  const commentsKey = JSON.stringify(
    options.comments.map(c => [c.id, c.type, c.number, c.originalText])
  )
  useEffect(() => {
    if (status === 'ready') replay()
  }, [status, commentsKey, options.inputMethod, options.annotateActive, replay])

  return {
    status,
    unavailable,
    headings,
    unanchoredIds,
    height,
    createMark: (id, type) =>
      post({ type: `${PN}create-mark`, id, annotationType: type }),
    cancelSelection: () => post({ type: `${PN}cancel-selection` }),
    removeMark: id => post({ type: `${PN}remove-mark`, id }),
    scrollTo: id => {
      post({ type: `${PN}scroll-to`, id })
      post({ type: `${PN}focus-mark`, id })
    },
    scrollToFragment: id =>
      post({ type: `${PN}scroll-to-fragment`, fragment: id }),
    setEditMode: on => post({ type: `${PN}set-edit-mode`, on }),
    serialize: () => post({ type: `${PN}serialize` }),
    applyReplacement: (id, text) =>
      post({ type: `${PN}apply-replacement`, id, text }),
  }
}
