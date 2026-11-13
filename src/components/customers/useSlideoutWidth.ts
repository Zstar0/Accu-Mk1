import * as React from 'react'

export const SLIDEOUT_STEP = 32
const KEY = 'mk1.customerSlideoutWidth'
const DEFAULT_WIDTH = 576
const MIN_WIDTH = 400
const DESKTOP_MIN = 640

const maxFor = (vw: number) => vw * 0.9
const clamp = (w: number, vw: number) =>
  Math.max(MIN_WIDTH, Math.min(maxFor(vw), w))

function readStored(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key))
    return Number.isFinite(n) && n > 0 ? n : fallback
  } catch {
    return fallback
  }
}

function writeStored(key: string, w: number) {
  try {
    localStorage.setItem(key, String(w))
  } catch {
    // storage blocked: width just won't persist
  }
}

/** Shared, persisted width for the customer-page slide-outs. */
export function useSlideoutWidth({
  key = KEY,
  defaultWidth = DEFAULT_WIDTH,
}: { key?: string; defaultWidth?: number } = {}) {
  const [raw, setRaw] = React.useState(() => readStored(key, defaultWidth))
  const [vw, setVw] = React.useState(() => window.innerWidth)
  const latest = React.useRef(raw)

  React.useEffect(() => {
    const onResize = () => setVw(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const width = clamp(raw, vw)
  const set = (w: number, persist: boolean) => {
    const next = clamp(w, window.innerWidth)
    latest.current = next
    setRaw(next)
    if (persist) writeStored(key, next)
  }
  return {
    width,
    desktop: vw >= DESKTOP_MIN,
    min: MIN_WIDTH,
    max: maxFor(vw),
    drag: (w: number) => set(w, false),
    commit: () => writeStored(key, latest.current),
    nudge: (delta: number) => set(width + delta, true),
    reset: () => set(defaultWidth, true),
  }
}
