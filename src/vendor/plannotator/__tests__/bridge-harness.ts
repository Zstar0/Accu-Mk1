/**
 * Runs the real bridge IIFE inside vitest's jsdom window. In jsdom the top
 * window is its own `parent`, so the bridge's `parent.postMessage` lands on
 * this window (that is what a real parent would receive) and
 * a dispatched MessageEvent (source: window) plays the parent's role. Load ONCE per test file: the
 * IIFE registers global listeners that cannot be unregistered.
 */
import { BRIDGE_SCRIPT } from '../bridge-script'

export type BridgeMsg = { type: string } & Record<string, unknown>

export function loadBridge(bodyHtml: string, headHtml = '') {
  document.head.innerHTML = headHtml
  document.body.innerHTML = bodyHtml
  const posted: BridgeMsg[] = []
  const onMessage = (e: MessageEvent) => {
    const d = e.data as BridgeMsg | null
    if (d && typeof d.type === 'string' && d.type.startsWith('plannotator-bridge-')) posted.push(d)
  }
  window.addEventListener('message', onMessage)
  new Function(BRIDGE_SCRIPT)()
  const tick = () => new Promise<void>(r => setTimeout(r, 0))
  return {
    posted,
    tick,
    async send(msg: BridgeMsg) {
      // jsdom's postMessage leaves `source` null, but the bridge only trusts
      // `e.source === parent`, so dispatch the event with the source set.
      window.dispatchEvent(new MessageEvent('message', { data: msg, source: window }))
      await tick()
      await tick()
    },
    last(type: string) {
      return [...posted].reverse().find(m => m.type === `plannotator-bridge-${type}`)
    },
    dispose() {
      window.removeEventListener('message', onMessage)
    },
  }
}
