import { act, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION } from '@/vendor/plannotator/bridge-script'
import {
  openDocumentLink,
  useDocumentBridge,
  type BridgeComment,
  type DocumentBridge,
} from '../useDocumentBridge'

/** Reports the latest hook value on every render; the frame is read from the DOM by title. */
function Harness({
  comments,
  onBridge,
  onSelection = vi.fn(),
}: {
  comments: BridgeComment[]
  onBridge: (b: DocumentBridge) => void
  onSelection?: (s: unknown) => void
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const bridge = useDocumentBridge({
    iframeRef: ref,
    documentKey: 'doc',
    comments,
    inputMethod: 'drag',
    annotateActive: true,
    onSelection,
    onMarkClick: vi.fn(),
    readyTimeoutMs: 200,
  })
  onBridge(bridge)
  return (
    <iframe ref={ref} title="t" sandbox="allow-scripts" srcDoc="<p>x</p>" />
  )
}

const theFrame = () => screen.getByTitle('t') as HTMLIFrameElement

function frameMessage(
  data: unknown,
  origin = 'null',
  source: Window | null = theFrame().contentWindow
) {
  window.dispatchEvent(
    new MessageEvent('message', { data, origin, source: source ?? undefined })
  )
}

const comment: BridgeComment = {
  id: '5',
  type: 'comment',
  originalText: 'hello',
  anchor: null,
  additionalAnchors: null,
  number: 1,
}

describe('useDocumentBridge', () => {
  it('ignores messages from the wrong source or a non-null origin', () => {
    let bridge!: DocumentBridge
    const onSelection = vi.fn()
    render(
      <Harness
        comments={[]}
        onSelection={onSelection}
        onBridge={b => {
          bridge = b
        }}
      />
    )
    expect(theFrame().contentWindow).toBeTruthy()
    const sel = {
      type: 'plannotator-bridge-selection',
      text: 'q',
      rect: { top: 0, left: 0, width: 1, height: 1 },
    }
    act(() => frameMessage(sel, 'null', window))
    act(() => frameMessage(sel, 'https://evil.example'))
    expect(onSelection).not.toHaveBeenCalled()
    act(() => frameMessage(sel))
    expect(onSelection).toHaveBeenCalledTimes(1)
    expect(bridge.status).toBe('loading')
  })

  it('marks the bridge unavailable on a version mismatch', async () => {
    let bridge!: DocumentBridge
    render(
      <Harness
        comments={[]}
        onBridge={b => {
          bridge = b
        }}
      />
    )
    act(() =>
      frameMessage({
        type: 'plannotator-bridge-ready',
        protocolVersion: BRIDGE_PROTOCOL_VERSION + 1,
      })
    )
    await waitFor(() =>
      expect(bridge.unavailable).toEqual({
        kind: 'version-mismatch',
        reported: BRIDGE_PROTOCOL_VERSION + 1,
      })
    )
  })

  it('on ready replays every comment as find-and-mark, then numbering and the unanchored request', async () => {
    render(<Harness comments={[comment]} onBridge={vi.fn()} />)
    const win = theFrame().contentWindow
    if (!win) throw new Error('no contentWindow')
    const post = vi.spyOn(win, 'postMessage')
    act(() =>
      frameMessage({
        type: 'plannotator-bridge-ready',
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
      })
    )
    await waitFor(() => expect(post).toHaveBeenCalled())
    const types = post.mock.calls.map(c =>
      (c[0] as { type: string }).type.replace('plannotator-bridge-', '')
    )
    expect(types).toEqual(
      expect.arrayContaining([
        'set-input-method',
        'set-annotate-mode',
        'clear-marks',
        'find-and-mark',
        'sync-annotations',
        'report-unanchored',
      ])
    )
    const fam = post.mock.calls.find(
      c =>
        (c[0] as { type: string }).type === 'plannotator-bridge-find-and-mark'
    )?.[0]
    expect(fam).toMatchObject({
      id: '5',
      annotationType: 'comment',
      originalText: 'hello',
    })
    expect(post.mock.calls.every(c => (c as unknown[])[1] === '*')).toBe(true)
  })

  it('times out to unavailable when no ready arrives', async () => {
    let bridge!: DocumentBridge
    render(
      <Harness
        comments={[]}
        onBridge={b => {
          bridge = b
        }}
      />
    )
    await waitFor(
      () => expect(bridge.unavailable).toEqual({ kind: 'timeout' }),
      { timeout: 1000 }
    )
  })
})

describe('openDocumentLink', () => {
  it('opens only http(s) in a new tab', () => {
    const open = vi.fn()
    openDocumentLink('https://x.y/z', open)
    openDocumentLink('http://x.y/z', open)
    openDocumentLink('javascript:alert(1)', open)
    openDocumentLink('file:///etc/passwd', open)
    openDocumentLink('/relative', open)
    expect(open.mock.calls.map(c => c[0])).toEqual([
      'https://x.y/z',
      'http://x.y/z',
    ])
  })
})
